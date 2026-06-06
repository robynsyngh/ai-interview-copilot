"""Centralized configuration loaded from environment variables.

Mirrors the keys defined in the repo-level `.env.example`. Anything that the
runtime should be able to swap (DB URL, model names, CORS origins, API keys)
flows through this single `Settings` object.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env", "../../.env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_cors_origins: str = "http://localhost:3000,chrome-extension://*"
    log_level: str = "INFO"

    database_url: str = Field(
        default="postgresql+psycopg://copilot:copilot_dev_password@localhost:5432/copilot",
        description="SQLAlchemy/SQLModel DSN.",
    )

    deepgram_api_key: str = Field(default="", description="Deepgram Nova-2 API key.")
    deepgram_model: str = "nova-2"

    github_models_token: str = Field(default="", description="GitHub PAT with models:read scope.")
    github_models_endpoint: str = "https://models.inference.ai.azure.com"
    github_models_name: str = "gpt-4o-mini"

    # Google Gemini, used as an automatic fallback when GitHub Models is rate
    # limited. Uses Gemini's OpenAI-compatible endpoint so the request/response
    # shape matches GitHub Models exactly.
    gemini_api_key: str = Field(default="", description="Google AI Studio (Gemini) API key.")
    gemini_endpoint: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    gemini_model: str = "gemini-2.0-flash"

    # Comma-separated provider order for LLM calls. The first reachable, non
    # rate-limited provider wins; the rest are tried on 429/5xx. Valid names:
    # "github", "gemini".
    model_provider_order: str = "github,gemini"

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.api_cors_origins.split(",") if origin.strip()]

    @property
    def provider_order_list(self) -> list[str]:
        return [p.strip().lower() for p in self.model_provider_order.split(",") if p.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
