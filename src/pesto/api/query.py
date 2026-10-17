"""The shared base for the query models of the run routes."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class RunQuery(BaseModel):
    """The security middleware already read the token; it is declared here only so the
    ``?token=`` form is not refused. ``extra="forbid"`` still turns any other unknown field into a 422."""

    model_config = ConfigDict(extra="forbid")

    token: str | None = Field(default=None, exclude=True)
