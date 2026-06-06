from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from typing import Dict, List, Optional
import uuid
import asyncio
from pathlib import Path
import os
import numpy as np

from proto.seismic_data_pb2 import (
    WebSocketMessage, MessageType, SEGYHeader,
    DataBlock, DatasetMetadata, ProgressUpdate,
    ErrorMessage, BlockRequest, ViewFrustum, BoundingBox, BlockInfo
)
from segy_parser import SEGYParser, DataBlockManager


app = FastAPI(title="Seismic Strata Visualization API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)
CACHE_DIR = Path("cache")
CACHE_DIR.mkdir(exist_ok=True)


class DatasetSession:
    def __init__(self, dataset_id: str, filepath: Path):
        self.dataset_id = dataset_id
        self.filepath = filepath
        self.parser: Optional[SEGYParser] = None
        self.block_manager: Optional[DataBlockManager] = None
        self.initialized = False
    
    async def initialize(self):
        loop = asyncio.get_event_loop()
        self.parser = await loop.run_in_executor(None, self._parse_file)
        self.block_manager = DataBlockManager(self.parser, str(CACHE_DIR / self.dataset_id))
        await loop.run_in_executor(None, self.block_manager.initialize, 64)
        self.initialized = True
    
    def _parse_file(self) -> SEGYParser:
        parser = SEGYParser(str(self.filepath))
        parser.parse()
        return parser
    
    def get_segy_header(self) -> SEGYHeader:
        h = self.parser.binary_header
        return SEGYHeader(
            job_id=h.job_id,
            line_number=h.line_number,
            reel_number=h.reel_number,
            num_traces=h.num_traces,
            num_aux_traces=h.num_aux_traces,
            sample_interval=h.sample_interval,
            sample_interval_original=h.sample_interval_original,
            num_samples=h.num_samples,
            num_samples_original=h.num_samples_original,
            data_sample_format=h.data_sample_format,
            ensemble_fold=h.ensemble_fold,
            trace_sorting=h.trace_sorting,
            measurement_system=h.measurement_system,
            coordinate_units=h.coordinate_units,
            num_priority=h.num_priority,
            min_x=h.min_x,
            max_x=h.max_x,
            min_y=h.min_y,
            max_y=h.max_y,
            min_z=h.min_z,
            max_z=h.max_z,
            inline_min=h.inline_min,
            inline_max=h.inline_max,
            xline_min=h.xline_min,
            xline_max=h.xline_max,
            inline_step=h.inline_step,
            xline_step=h.xline_step,
        )
    
    def get_metadata(self) -> DatasetMetadata:
        header = self.get_segy_header()
        blocks = []
        for blk in self.block_manager.octree.blocks.values():
            blocks.append(BlockInfo(
                block_id=blk.block_id,
                level=blk.level,
                bounding_box=BoundingBox(
                    min_x=blk.bounding_box['min_x'],
                    max_x=blk.bounding_box['max_x'],
                    min_y=blk.bounding_box['min_y'],
                    max_y=blk.bounding_box['max_y'],
                    min_z=blk.bounding_box['min_z'],
                    max_z=blk.bounding_box['max_z'],
                ),
                data_size=blk.data_size,
            ))
        
        return DatasetMetadata(
            dataset_id=self.dataset_id,
            name=self.filepath.stem,
            file_size=self.filepath.stat().st_size,
            header=header,
            blocks=blocks,
        )
    
    async def get_block_data(self, block_id: str) -> Optional[DataBlock]:
        if not self.block_manager or block_id not in self.block_manager.octree.blocks:
            return None
        
        blk_info = self.block_manager.octree.blocks[block_id]
        loop = asyncio.get_event_loop()
        compressed_data = await loop.run_in_executor(
            None, self.block_manager.get_block_data, blk_info
        )
        
        return DataBlock(
            block_id=blk_info.block_id,
            level=blk_info.level,
            inline_start=blk_info.inline_start,
            inline_end=blk_info.inline_end,
            xline_start=blk_info.xline_start,
            xline_end=blk_info.xline_end,
            depth_start=blk_info.depth_start,
            depth_end=blk_info.depth_end,
            num_inline=blk_info.num_inline,
            num_xline=blk_info.num_xline,
            num_depth=blk_info.num_depth,
            amplitude_data=compressed_data,
            min_amplitude=blk_info.min_amplitude,
            max_amplitude=blk_info.max_amplitude,
            bounding_box=BoundingBox(
                min_x=blk_info.bounding_box['min_x'],
                max_x=blk_info.bounding_box['max_x'],
                min_y=blk_info.bounding_box['min_y'],
                max_y=blk_info.bounding_box['max_y'],
                min_z=blk_info.bounding_box['min_z'],
                max_z=blk_info.bounding_box['max_z'],
            ),
        )
    
    def get_visible_blocks(self, view_frustum: ViewFrustum) -> List[str]:
        if not self.block_manager or not self.block_manager.octree:
            return []
        
        matrix = np.array(view_frustum.matrix).reshape(4, 4)
        visible = self.block_manager.octree.get_visible_blocks(
            matrix, view_frustum.fov, view_frustum.aspect,
            view_frustum.near, view_frustum.far
        )
        
        return [blk.block_id for blk in visible]


class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.sessions: Dict[str, DatasetSession] = {}
    
    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket
    
    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
    
    async def send_message(self, client_id: str, message: WebSocketMessage):
        if client_id in self.active_connections:
            await self.active_connections[client_id].send_bytes(message.serialize())


manager = ConnectionManager()


@app.get("/")
async def root():
    return {"status": "running", "service": "Seismic Strata Visualization Backend"}


@app.get("/datasets")
async def list_datasets():
    datasets = []
    for item in UPLOAD_DIR.iterdir():
        if item.suffix.lower() in ['.sgy', '.segy']:
            datasets.append({
                "name": item.stem,
                "filename": item.name,
                "size": item.stat().st_size,
            })
    return {"datasets": datasets}


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    dataset_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"{dataset_id}_{file.filename}"
    
    with open(file_path, "wb") as buffer:
        content = await file.read()
        buffer.write(content)
    
    return {
        "dataset_id": dataset_id,
        "filename": file.filename,
        "size": len(content),
    }


@app.get("/datasets/{dataset_id}/metadata")
async def get_dataset_metadata(dataset_id: str):
    session = manager.sessions.get(dataset_id)
    if not session:
        segy_files = list(UPLOAD_DIR.glob(f"{dataset_id}_*"))
        if not segy_files:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        session = DatasetSession(dataset_id, segy_files[0])
        await session.initialize()
        manager.sessions[dataset_id] = session
    
    metadata = session.get_metadata()
    return JSONResponse(content=metadata.to_dict())


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)
    
    try:
        while True:
            data = await websocket.receive_bytes()
            message = WebSocketMessage.deserialize(data)
            
            if message.type == MessageType.REQUEST_BLOCK and message.block_request:
                await handle_block_request(client_id, message)
            
            elif message.type == MessageType.VIEW_FRUSTUM and message.view_frustum:
                await handle_view_frustum(client_id, message)
            
            elif message.type == MessageType.METADATA:
                await handle_metadata_request(client_id, message)
    
    except WebSocketDisconnect:
        manager.disconnect(client_id)


async def handle_block_request(client_id: str, message: WebSocketMessage):
    request = message.block_request
    dataset_id = message.request_id
    
    if dataset_id not in manager.sessions:
        segy_files = list(UPLOAD_DIR.glob(f"{dataset_id}_*"))
        if not segy_files:
            error_msg = WebSocketMessage(
                type=MessageType.ERROR,
                request_id=message.request_id,
                error=ErrorMessage(code=404, message="Dataset not found", details="")
            )
            await manager.send_message(client_id, error_msg)
            return
        
        session = DatasetSession(dataset_id, segy_files[0])
        
        progress_msg = WebSocketMessage(
            type=MessageType.PROGRESS,
            request_id=dataset_id,
            progress=ProgressUpdate(
                percent_complete=0.0,
                message="Initializing dataset...",
                bytes_processed=0,
                total_bytes=segy_files[0].stat().st_size,
            )
        )
        await manager.send_message(client_id, progress_msg)
        
        await session.initialize()
        manager.sessions[dataset_id] = session
        
        header_msg = WebSocketMessage(
            type=MessageType.HEADER,
            request_id=dataset_id,
            header=session.get_segy_header(),
        )
        await manager.send_message(client_id, header_msg)
        
        metadata_msg = WebSocketMessage(
            type=MessageType.METADATA,
            request_id=dataset_id,
            metadata=session.get_metadata(),
        )
        await manager.send_message(client_id, metadata_msg)
    else:
        session = manager.sessions[dataset_id]
    
    if request.stream:
        for i, block_id in enumerate(request.block_ids):
            block_data = await session.get_block_data(block_id)
            if block_data:
                block_msg = WebSocketMessage(
                    type=MessageType.DATA_BLOCK,
                    request_id=dataset_id,
                    data_block=block_data,
                )
                await manager.send_message(client_id, block_msg)
                
                if i % 5 == 0:
                    progress = (i + 1) / len(request.block_ids) * 100
                    progress_msg = WebSocketMessage(
                        type=MessageType.PROGRESS,
                        request_id=dataset_id,
                        progress=ProgressUpdate(
                            percent_complete=progress,
                            message=f"Streaming blocks... {i+1}/{len(request.block_ids)}",
                            bytes_processed=i + 1,
                            total_bytes=len(request.block_ids),
                        )
                    )
                    await manager.send_message(client_id, progress_msg)
        
        complete_msg = WebSocketMessage(
            type=MessageType.COMPLETE,
            request_id=dataset_id,
        )
        await manager.send_message(client_id, complete_msg)


async def handle_view_frustum(client_id: str, message: WebSocketMessage):
    dataset_id = message.request_id
    
    if dataset_id not in manager.sessions:
        return
    
    session = manager.sessions[dataset_id]
    visible_block_ids = session.get_visible_blocks(message.view_frustum)
    
    block_request = BlockRequest(
        block_ids=visible_block_ids[:50],
        level=0,
        stream=True,
    )
    
    request_msg = WebSocketMessage(
        type=MessageType.REQUEST_BLOCK,
        request_id=dataset_id,
        block_request=block_request,
    )
    
    await handle_block_request(client_id, request_msg)


async def handle_metadata_request(client_id: str, message: WebSocketMessage):
    dataset_id = message.request_id
    
    if dataset_id not in manager.sessions:
        segy_files = list(UPLOAD_DIR.glob(f"{dataset_id}_*"))
        if not segy_files:
            error_msg = WebSocketMessage(
                type=MessageType.ERROR,
                request_id=message.request_id,
                error=ErrorMessage(code=404, message="Dataset not found", details="")
            )
            await manager.send_message(client_id, error_msg)
            return
        
        session = DatasetSession(dataset_id, segy_files[0])
        await session.initialize()
        manager.sessions[dataset_id] = session
    else:
        session = manager.sessions[dataset_id]
    
    metadata_msg = WebSocketMessage(
        type=MessageType.METADATA,
        request_id=dataset_id,
        metadata=session.get_metadata(),
    )
    await manager.send_message(client_id, metadata_msg)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
