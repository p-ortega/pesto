"""The directory picker (Plan 05-03): opaque ids only, never a real path."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/fs")
