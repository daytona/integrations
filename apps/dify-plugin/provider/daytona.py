from typing import Any

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from _client import build_client


class DaytonaProvider(ToolProvider):
    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        try:
            daytona = build_client(credentials)
            daytona.list(limit=1)
        except Exception as e:
            raise ToolProviderCredentialValidationError(str(e))
