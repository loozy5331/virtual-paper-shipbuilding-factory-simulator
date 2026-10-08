"""종이배 조선소 시뮬레이션 엔진."""

__version__ = "1.0.0"

from .sim import (
    ConfigError,
    load_presets,
    load_scenario,
    max_rate,
    preview,
    simulate,
    suggest_order_days,
    validate_config,
)

__all__ = [
    "__version__",
    "ConfigError",
    "load_presets",
    "load_scenario",
    "max_rate",
    "preview",
    "simulate",
    "suggest_order_days",
    "validate_config",
]
