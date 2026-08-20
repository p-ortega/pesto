"""The mesh and the cell arrays (Plan 05-05): raw little-endian bytes, no parsing."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/run/grid")
