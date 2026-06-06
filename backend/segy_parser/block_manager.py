import numpy as np
import zlib
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional, Callable
from pathlib import Path
import hashlib
import json
import struct

from .parser import SEGYParser, SEGYBinaryHeader


@dataclass
class BlockInfo:
    block_id: str
    level: int
    inline_start: int
    inline_end: int
    xline_start: int
    xline_end: int
    depth_start: int
    depth_end: int
    num_inline: int
    num_xline: int
    num_depth: int
    min_amplitude: float
    max_amplitude: float
    bounding_box: Dict[str, float]
    data_size: int = 0


@dataclass
class OctreeNode:
    node_id: str
    level: int
    bounds: Tuple[Tuple[int, int], Tuple[int, int], Tuple[int, int]]
    children: List['OctreeNode'] = field(default_factory=list)
    parent: Optional['OctreeNode'] = None
    data_block: Optional[BlockInfo] = None
    
    @property
    def is_leaf(self) -> bool:
        return len(self.children) == 0


class OctreeBuilder:
    def __init__(self, header: SEGYBinaryHeader, max_block_size: int = 64):
        self.header = header
        self.max_block_size = max_block_size
        self.root: Optional[OctreeNode] = None
        self.blocks: Dict[str, BlockInfo] = {}
    
    def build(self) -> OctreeNode:
        inline_range = (self.header.inline_min, self.header.inline_max)
        xline_range = (self.header.xline_min, self.header.xline_max)
        depth_range = (0, self.header.num_samples)
        
        self.root = self._build_recursive(
            inline_range, xline_range, depth_range, level=0, parent=None
        )
        return self.root
    
    def _build_recursive(
        self,
        inline_range: Tuple[int, int],
        xline_range: Tuple[int, int],
        depth_range: Tuple[int, int],
        level: int,
        parent: Optional[OctreeNode]
    ) -> OctreeNode:
        inline_start, inline_end = inline_range
        xline_start, xline_end = xline_range
        depth_start, depth_end = depth_range
        
        node_id = self._generate_node_id(
            inline_start, inline_end, xline_start, xline_end, depth_start, depth_end
        )
        
        num_inline = (inline_end - inline_start) // self.header.inline_step + 1
        num_xline = (xline_end - xline_start) // self.header.xline_step + 1
        num_depth = depth_end - depth_start
        
        node = OctreeNode(
            node_id=node_id,
            level=level,
            bounds=(inline_range, xline_range, depth_range),
            parent=parent
        )
        
        should_split = (
            num_inline > self.max_block_size or
            num_xline > self.max_block_size or
            num_depth > self.max_block_size
        )
        
        if should_split:
            children = self._split_node(
                inline_range, xline_range, depth_range, level, node
            )
            node.children = children
        else:
            block_info = self._create_block_info(
                inline_start, inline_end,
                xline_start, xline_end,
                depth_start, depth_end,
                level
            )
            node.data_block = block_info
            self.blocks[block_info.block_id] = block_info
        
        return node
    
    def _split_node(
        self,
        inline_range: Tuple[int, int],
        xline_range: Tuple[int, int],
        depth_range: Tuple[int, int],
        level: int,
        parent: OctreeNode
    ) -> List[OctreeNode]:
        inline_start, inline_end = inline_range
        xline_start, xline_end = xline_range
        depth_start, depth_end = depth_range
        
        inline_mid = (inline_start + inline_end) // 2
        xline_mid = (xline_start + xline_end) // 2
        depth_mid = (depth_start + depth_end) // 2
        
        inline_mid = self._snap_to_grid(inline_mid, self.header.inline_step, inline_start)
        xline_mid = self._snap_to_grid(xline_mid, self.header.xline_step, xline_start)
        
        octants = [
            ((inline_start, inline_mid), (xline_start, xline_mid), (depth_start, depth_mid)),
            ((inline_mid + self.header.inline_step, inline_end), (xline_start, xline_mid), (depth_start, depth_mid)),
            ((inline_start, inline_mid), (xline_mid + self.header.xline_step, xline_end), (depth_start, depth_mid)),
            ((inline_mid + self.header.inline_step, inline_end), (xline_mid + self.header.xline_step, xline_end), (depth_start, depth_mid)),
            ((inline_start, inline_mid), (xline_start, xline_mid), (depth_mid + 1, depth_end)),
            ((inline_mid + self.header.inline_step, inline_end), (xline_start, xline_mid), (depth_mid + 1, depth_end)),
            ((inline_start, inline_mid), (xline_mid + self.header.xline_step, xline_end), (depth_mid + 1, depth_end)),
            ((inline_mid + self.header.inline_step, inline_end), (xline_mid + self.header.xline_step, xline_end), (depth_mid + 1, depth_end)),
        ]
        
        children = []
        for ir, xr, dr in octants:
            if ir[0] <= ir[1] and xr[0] <= xr[1] and dr[0] <= dr[1]:
                child = self._build_recursive(ir, xr, dr, level + 1, parent)
                children.append(child)
        
        return children
    
    def _snap_to_grid(self, value: int, step: int, min_val: int) -> int:
        offset = (value - min_val) % step
        return value - offset
    
    def _generate_node_id(
        self,
        inline_start: int, inline_end: int,
        xline_start: int, xline_end: int,
        depth_start: int, depth_end: int
    ) -> str:
        raw = f"{inline_start}_{inline_end}_{xline_start}_{xline_end}_{depth_start}_{depth_end}"
        return hashlib.md5(raw.encode()).hexdigest()[:16]
    
    def _create_block_info(
        self,
        inline_start: int, inline_end: int,
        xline_start: int, xline_end: int,
        depth_start: int, depth_end: int,
        level: int
    ) -> BlockInfo:
        num_inline = (inline_end - inline_start) // self.header.inline_step + 1
        num_xline = (xline_end - xline_start) // self.header.xline_step + 1
        num_depth = depth_end - depth_start
        
        block_id = self._generate_node_id(
            inline_start, inline_end, xline_start, xline_end, depth_start, depth_end
        )
        
        x_range = self.header.max_x - self.header.min_x
        y_range = self.header.max_y - self.header.min_y
        z_range = self.header.max_z - self.header.min_z
        
        total_inlines = (self.header.inline_max - self.header.inline_min) // self.header.inline_step + 1
        total_xlines = (self.header.xline_max - self.header.xline_min) // self.header.xline_step + 1
        total_depths = self.header.num_samples
        
        min_x = self.header.min_x + (inline_start - self.header.inline_min) / max(1, total_inlines - 1) * x_range
        max_x = self.header.min_x + (inline_end - self.header.inline_min) / max(1, total_inlines - 1) * x_range
        min_y = self.header.min_y + (xline_start - self.header.xline_min) / max(1, total_xlines - 1) * y_range
        max_y = self.header.min_y + (xline_end - self.header.xline_min) / max(1, total_xlines - 1) * y_range
        min_z = self.header.min_z + depth_start / max(1, total_depths) * z_range
        max_z = self.header.min_z + depth_end / max(1, total_depths) * z_range
        
        return BlockInfo(
            block_id=block_id,
            level=level,
            inline_start=inline_start,
            inline_end=inline_end,
            xline_start=xline_start,
            xline_end=xline_end,
            depth_start=depth_start,
            depth_end=depth_end,
            num_inline=num_inline,
            num_xline=num_xline,
            num_depth=num_depth,
            min_amplitude=0.0,
            max_amplitude=0.0,
            bounding_box={
                'min_x': min_x, 'max_x': max_x,
                'min_y': min_y, 'max_y': max_y,
                'min_z': min_z, 'max_z': max_z,
            },
            data_size=num_inline * num_xline * num_depth * 4
        )
    
    def get_visible_blocks(
        self,
        view_matrix: np.ndarray,
        fov: float,
        aspect: float,
        near: float,
        far: float
    ) -> List[BlockInfo]:
        if not self.root:
            return []
        
        frustum = self._extract_frustum_planes(view_matrix, fov, aspect, near, far)
        visible_blocks = []
        self._cull_recursive(self.root, frustum, visible_blocks)
        return visible_blocks
    
    def _extract_frustum_planes(
        self,
        view_matrix: np.ndarray,
        fov: float,
        aspect: float,
        near: float,
        far: float
    ) -> List[np.ndarray]:
        planes = []
        tan_half_fov = np.tan(fov / 2)
        near_h = near * tan_half_fov
        near_w = near_h * aspect
        far_h = far * tan_half_fov
        far_w = far_h * aspect
        
        cam_pos = -view_matrix[:3, 3].T @ view_matrix[:3, :3]
        cam_dir = view_matrix[2, :3]
        cam_up = view_matrix[1, :3]
        cam_right = view_matrix[0, :3]
        
        nc = cam_pos + cam_dir * near
        fc = cam_pos + cam_dir * far
        
        ntl = nc + cam_up * near_h - cam_right * near_w
        ntr = nc + cam_up * near_h + cam_right * near_w
        nbl = nc - cam_up * near_h - cam_right * near_w
        nbr = nc - cam_up * near_h + cam_right * near_w
        ftl = fc + cam_up * far_h - cam_right * far_w
        ftr = fc + cam_up * far_h + cam_right * far_w
        fbl = fc - cam_up * far_h - cam_right * far_w
        fbr = fc - cam_up * far_h + cam_right * far_w
        
        def plane(p1, p2, p3):
            v1 = p2 - p1
            v2 = p3 - p1
            normal = np.cross(v1, v2)
            normal = normal / np.linalg.norm(normal)
            d = -np.dot(normal, p1)
            return np.array([*normal, d])
        
        planes.append(plane(ntl, nbl, ftl))
        planes.append(plane(nbr, ntr, fbr))
        planes.append(plane(ntl, ntr, ftl))
        planes.append(plane(nbl, fbl, nbr))
        planes.append(plane(ntl, nbl, nbr))
        planes.append(plane(ftl, fbr, ftr))
        
        return planes
    
    def _cull_recursive(
        self,
        node: OctreeNode,
        frustum: List[np.ndarray],
        visible_blocks: List[BlockInfo]
    ) -> None:
        if node.data_block:
            if self._is_block_visible(node.data_block, frustum):
                visible_blocks.append(node.data_block)
        else:
            for child in node.children:
                if self._is_node_visible(child, frustum):
                    self._cull_recursive(child, frustum, visible_blocks)
    
    def _is_block_visible(self, block: BlockInfo, frustum: List[np.ndarray]) -> bool:
        bb = block.bounding_box
        corners = []
        for x in [bb['min_x'], bb['max_x']]:
            for y in [bb['min_y'], bb['max_y']]:
                for z in [bb['min_z'], bb['max_z']]:
                    corners.append(np.array([x, y, z, 1.0]))
        
        for plane in frustum:
            all_out = True
            for corner in corners:
                if np.dot(plane, corner) >= 0:
                    all_out = False
                    break
            if all_out:
                return False
        
        return True
    
    def _is_node_visible(self, node: OctreeNode, frustum: List[np.ndarray]) -> bool:
        if node.data_block:
            return self._is_block_visible(node.data_block, frustum)
        
        ir, xr, dr = node.bounds
        
        x_range = self.header.max_x - self.header.min_x
        y_range = self.header.max_y - self.header.min_y
        z_range = self.header.max_z - self.header.min_z
        
        total_inlines = (self.header.inline_max - self.header.inline_min) // self.header.inline_step + 1
        total_xlines = (self.header.xline_max - self.header.xline_min) // self.header.xline_step + 1
        total_depths = self.header.num_samples
        
        min_x = self.header.min_x + (ir[0] - self.header.inline_min) / max(1, total_inlines - 1) * x_range
        max_x = self.header.min_x + (ir[1] - self.header.inline_min) / max(1, total_inlines - 1) * x_range
        min_y = self.header.min_y + (xr[0] - self.header.xline_min) / max(1, total_xlines - 1) * y_range
        max_y = self.header.min_y + (xr[1] - self.header.xline_min) / max(1, total_xlines - 1) * y_range
        min_z = self.header.min_z + dr[0] / max(1, total_depths) * z_range
        max_z = self.header.min_z + dr[1] / max(1, total_depths) * z_range
        
        temp_block = BlockInfo(
            block_id='', level=0,
            inline_start=0, inline_end=0,
            xline_start=0, xline_end=0,
            depth_start=0, depth_end=0,
            num_inline=0, num_xline=0, num_depth=0,
            min_amplitude=0, max_amplitude=0,
            bounding_box={
                'min_x': min_x, 'max_x': max_x,
                'min_y': min_y, 'max_y': max_y,
                'min_z': min_z, 'max_z': max_z,
            }
        )
        
        return self._is_block_visible(temp_block, frustum)


class DataBlockManager:
    def __init__(self, parser: SEGYParser, cache_dir: str = 'cache'):
        self.parser = parser
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
        self.octree: Optional[OctreeBuilder] = None
    
    def initialize(self, max_block_size: int = 64) -> OctreeBuilder:
        self.octree = OctreeBuilder(self.parser.binary_header, max_block_size)
        self.octree.build()
        return self.octree
    
    def get_block_data(self, block: BlockInfo) -> bytes:
        cache_path = self.cache_dir / f"{block.block_id}.bin"
        
        if cache_path.exists():
            with open(cache_path, 'rb') as f:
                compressed = f.read()
            return compressed
        
        volume, info = self.parser.read_volume_subset(
            block.inline_start, block.inline_end,
            block.xline_start, block.xline_end,
            block.depth_start, block.depth_end
        )
        
        block.min_amplitude = info['min_amplitude']
        block.max_amplitude = info['max_amplitude']
        
        raw_data = volume.tobytes()
        compressed = zlib.compress(raw_data, level=3)
        
        with open(cache_path, 'wb') as f:
            f.write(compressed)
        
        block.data_size = len(compressed)
        
        return compressed
    
    def decompress_block(self, compressed_data: bytes) -> np.ndarray:
        raw_data = zlib.decompress(compressed_data)
        return np.frombuffer(raw_data, dtype=np.float32)
    
    def save_metadata(self, dataset_id: str, filepath: str) -> None:
        if not self.octree:
            return
        
        metadata = {
            'dataset_id': dataset_id,
            'file_size': self.parser.file_size,
            'header': {
                'job_id': self.parser.binary_header.job_id,
                'line_number': self.parser.binary_header.line_number,
                'reel_number': self.parser.binary_header.reel_number,
                'num_traces': self.parser.binary_header.num_traces,
                'sample_interval': self.parser.binary_header.sample_interval,
                'num_samples': self.parser.binary_header.num_samples,
                'data_sample_format': self.parser.binary_header.data_sample_format,
                'measurement_system': self.parser.binary_header.measurement_system,
                'min_x': self.parser.binary_header.min_x,
                'max_x': self.parser.binary_header.max_x,
                'min_y': self.parser.binary_header.min_y,
                'max_y': self.parser.binary_header.max_y,
                'min_z': self.parser.binary_header.min_z,
                'max_z': self.parser.binary_header.max_z,
                'inline_min': self.parser.binary_header.inline_min,
                'inline_max': self.parser.binary_header.inline_max,
                'xline_min': self.parser.binary_header.xline_min,
                'xline_max': self.parser.binary_header.xline_max,
                'inline_step': self.parser.binary_header.inline_step,
                'xline_step': self.parser.binary_header.xline_step,
            },
            'blocks': [
                {
                    'block_id': blk.block_id,
                    'level': blk.level,
                    'bounding_box': blk.bounding_box,
                    'data_size': blk.data_size,
                }
                for blk in self.octree.blocks.values()
            ]
        }
        
        with open(filepath, 'w') as f:
            json.dump(metadata, f)
