import struct
import numpy as np
from dataclasses import dataclass, field
from typing import List, Tuple, Optional, BinaryIO
import os
from pathlib import Path


@dataclass
class SEGYBinaryHeader:
    job_id: int = 0
    line_number: int = 0
    reel_number: int = 0
    num_traces: int = 0
    num_aux_traces: int = 0
    sample_interval: int = 0
    sample_interval_original: int = 0
    num_samples: int = 0
    num_samples_original: int = 0
    data_sample_format: int = 5
    ensemble_fold: int = 0
    trace_sorting: int = 0
    measurement_system: int = 1
    coordinate_units: int = 1
    num_priority: int = 0
    min_x: float = 0.0
    max_x: float = 0.0
    min_y: float = 0.0
    max_y: float = 0.0
    min_z: float = 0.0
    max_z: float = 0.0
    inline_min: int = 0
    inline_max: int = 0
    xline_min: int = 0
    xline_max: int = 0
    inline_step: int = 1
    xline_step: int = 1


@dataclass
class TraceHeader:
    inline: int = 0
    xline: int = 0
    x: float = 0.0
    y: float = 0.0
    elevation: float = 0.0
    num_samples: int = 0
    sample_interval: int = 0


class SEGYParser:
    TEXT_HEADER_SIZE = 3200
    BINARY_HEADER_SIZE = 400
    TRACE_HEADER_SIZE = 240
    
    FORMAT_CODES = {
        1: ('ibm', 4),
        2: ('int32', 4),
        3: ('int16', 2),
        5: ('float32', 4),
        6: ('float64', 8),
        8: ('int8', 1),
    }
    
    def __init__(self, filepath: str):
        self.filepath = Path(filepath)
        self.file_size = self.filepath.stat().st_size
        self.binary_header: Optional[SEGYBinaryHeader] = None
        self.trace_headers: List[TraceHeader] = []
        self._sample_format: str = 'float32'
        self._sample_size: int = 4
        self._file_handle: Optional[BinaryIO] = None
    
    def __enter__(self):
        self._file_handle = open(self.filepath, 'rb')
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._file_handle:
            self._file_handle.close()
            self._file_handle = None
    
    def parse(self) -> SEGYBinaryHeader:
        if not self._file_handle:
            self._file_handle = open(self.filepath, 'rb')
        
        self._parse_text_header()
        self.binary_header = self._parse_binary_header()
        
        if self.binary_header.data_sample_format in self.FORMAT_CODES:
            self._sample_format, self._sample_size = self.FORMAT_CODES[
                self.binary_header.data_sample_format
            ]
        
        self._parse_all_trace_headers()
        self._compute_bounds()
        
        return self.binary_header
    
    def _parse_text_header(self) -> str:
        self._file_handle.seek(0)
        data = self._file_handle.read(self.TEXT_HEADER_SIZE)
        return data.decode('cp500', errors='ignore')
    
    def _parse_binary_header(self) -> SEGYBinaryHeader:
        self._file_handle.seek(self.TEXT_HEADER_SIZE)
        data = self._file_handle.read(self.BINARY_HEADER_SIZE)
        
        header = SEGYBinaryHeader()
        
        fields = [
            ('job_id', 3200, '>I'),
            ('line_number', 3204, '>I'),
            ('reel_number', 3208, '>I'),
            ('num_traces', 3212, '>H'),
            ('num_aux_traces', 3214, '>H'),
            ('sample_interval', 3216, '>H'),
            ('sample_interval_original', 3218, '>H'),
            ('num_samples', 3220, '>H'),
            ('num_samples_original', 3222, '>H'),
            ('data_sample_format', 3224, '>H'),
            ('ensemble_fold', 3226, '>H'),
            ('trace_sorting', 3228, '>H'),
            ('measurement_system', 3254, '>H'),
            ('coordinate_units', 3256, '>H'),
        ]
        
        for name, offset, fmt in fields:
            try:
                value = struct.unpack_from(fmt, data, offset - self.TEXT_HEADER_SIZE)[0]
                setattr(header, name, value)
            except:
                pass
        
        return header
    
    def _parse_trace_header(self, offset: int) -> TraceHeader:
        self._file_handle.seek(offset)
        data = self._file_handle.read(self.TRACE_HEADER_SIZE)
        
        th = TraceHeader()
        
        try:
            th.inline = struct.unpack_from('>I', data, 188)[0]
        except:
            th.inline = 0
        
        try:
            th.xline = struct.unpack_from('>I', data, 192)[0]
        except:
            th.xline = 0
        
        try:
            th.x = struct.unpack_from('>I', data, 80)[0]
        except:
            th.x = 0
        
        try:
            th.y = struct.unpack_from('>I', data, 84)[0]
        except:
            th.y = 0
        
        try:
            th.elevation = struct.unpack_from('>I', data, 40)[0]
        except:
            th.elevation = 0
        
        try:
            th.num_samples = struct.unpack_from('>H', data, 114)[0]
        except:
            th.num_samples = self.binary_header.num_samples if self.binary_header else 0
        
        try:
            th.sample_interval = struct.unpack_from('>H', data, 116)[0]
        except:
            th.sample_interval = self.binary_header.sample_interval if self.binary_header else 0
        
        return th
    
    def _parse_all_trace_headers(self) -> None:
        num_samples = self.binary_header.num_samples
        trace_size = self.TRACE_HEADER_SIZE + num_samples * self._sample_size
        
        first_trace_offset = self.TEXT_HEADER_SIZE + self.BINARY_HEADER_SIZE
        file_size = self.file_size
        
        current_offset = first_trace_offset
        trace_idx = 0
        
        while current_offset + trace_size <= file_size and trace_idx < 100000:
            th = self._parse_trace_header(current_offset)
            self.trace_headers.append(th)
            current_offset += trace_size
            trace_idx += 1
    
    def _compute_bounds(self) -> None:
        if not self.trace_headers:
            return
        
        inlines = [th.inline for th in self.trace_headers]
        xlines = [th.xline for th in self.trace_headers]
        xs = [th.x for th in self.trace_headers]
        ys = [th.y for th in self.trace_headers]
        
        self.binary_header.inline_min = min(inlines)
        self.binary_header.inline_max = max(inlines)
        self.binary_header.xline_min = min(xlines)
        self.binary_header.xline_max = max(xlines)
        self.binary_header.min_x = min(xs)
        self.binary_header.max_x = max(xs)
        self.binary_header.min_y = min(ys)
        self.binary_header.max_y = max(ys)
        
        num_samples = self.binary_header.num_samples
        sample_interval = self.binary_header.sample_interval / 1000.0
        self.binary_header.min_z = 0.0
        self.binary_header.max_z = num_samples * sample_interval
        
        unique_inlines = sorted(set(inlines))
        if len(unique_inlines) > 1:
            self.binary_header.inline_step = unique_inlines[1] - unique_inlines[0]
        
        unique_xlines = sorted(set(xlines))
        if len(unique_xlines) > 1:
            self.binary_header.xline_step = unique_xlines[1] - unique_xlines[0]
    
    def read_trace_data(self, trace_index: int) -> np.ndarray:
        if not self._file_handle:
            self._file_handle = open(self.filepath, 'rb')
        
        num_samples = self.binary_header.num_samples
        trace_size = self.TRACE_HEADER_SIZE + num_samples * self._sample_size
        first_trace_offset = self.TEXT_HEADER_SIZE + self.BINARY_HEADER_SIZE
        
        trace_offset = first_trace_offset + trace_index * trace_size
        data_offset = trace_offset + self.TRACE_HEADER_SIZE
        
        self._file_handle.seek(data_offset)
        raw_data = self._file_handle.read(num_samples * self._sample_size)
        
        if self._sample_format == 'float32':
            data = np.frombuffer(raw_data, dtype='>f4').astype(np.float32)
        elif self._sample_format == 'int16':
            data = np.frombuffer(raw_data, dtype='>i2').astype(np.float32)
        elif self._sample_format == 'int32':
            data = np.frombuffer(raw_data, dtype='>i4').astype(np.float32)
        elif self._sample_format == 'ibm':
            data = self._ibm_to_float(raw_data)
        else:
            data = np.frombuffer(raw_data, dtype='>f4').astype(np.float32)
        
        return data
    
    def _ibm_to_float(self, raw_data: bytes) -> np.ndarray:
        data = np.frombuffer(raw_data, dtype='>u4')
        sign = np.where(data & 0x80000000, -1.0, 1.0)
        exponent = ((data >> 24) & 0x7F).astype(np.float32)
        mantissa = (data & 0x00FFFFFF).astype(np.float32) / 0x00FFFFFF
        result = sign * mantissa * np.power(16.0, exponent - 64)
        return result.astype(np.float32)
    
    def get_trace_count(self) -> int:
        num_samples = self.binary_header.num_samples
        trace_size = self.TRACE_HEADER_SIZE + num_samples * self._sample_size
        first_trace_offset = self.TEXT_HEADER_SIZE + self.BINARY_HEADER_SIZE
        total_traces = (self.file_size - first_trace_offset) // trace_size
        return int(total_traces)
    
    def read_volume_subset(
        self,
        inline_start: int,
        inline_end: int,
        xline_start: int,
        xline_end: int,
        depth_start: int,
        depth_end: int
    ) -> Tuple[np.ndarray, dict]:
        inline_range = range(
            inline_start,
            inline_end + 1,
            self.binary_header.inline_step
        )
        xline_range = range(
            xline_start,
            xline_end + 1,
            self.binary_header.xline_step
        )
        
        num_inline = len(inline_range)
        num_xline = len(xline_range)
        num_depth = depth_end - depth_start
        
        volume = np.zeros((num_inline, num_xline, num_depth), dtype=np.float32)
        
        inline_to_idx = {il: i for i, il in enumerate(inline_range)}
        xline_to_idx = {xl: j for j, xl in enumerate(xline_range)}
        
        for trace_idx, th in enumerate(self.trace_headers):
            if th.inline in inline_to_idx and th.xline in xline_to_idx:
                i = inline_to_idx[th.inline]
                j = xline_to_idx[th.xline]
                trace_data = self.read_trace_data(trace_idx)
                volume[i, j, :] = trace_data[depth_start:depth_end]
        
        info = {
            'inline_start': inline_start,
            'inline_end': inline_end,
            'xline_start': xline_start,
            'xline_end': xline_end,
            'depth_start': depth_start,
            'depth_end': depth_end,
            'num_inline': num_inline,
            'num_xline': num_xline,
            'num_depth': num_depth,
            'min_amplitude': float(np.min(volume)) if volume.size > 0 else 0.0,
            'max_amplitude': float(np.max(volume)) if volume.size > 0 else 0.0,
        }
        
        return volume, info
