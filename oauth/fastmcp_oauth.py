import asyncio
import os

from fastmcp import Client
from fastmcp.client.auth import OAuth


def _parse_scopes(value: str | None) -> list[str]:
    if not value:
        return []
    normalized = value.replace(",", " ")
    return [scope.strip() for scope in normalized.split() if scope.strip()]


async def main() -> None:
    server_url = os.getenv("FASTMCP_SERVER_URL", "http://127.0.0.1:8000/mcp")
    scopes = _parse_scopes(os.getenv("FASTMCP_CLIENT_SCOPES"))
    oauth = OAuth(scopes=scopes) if scopes else OAuth()

    async with Client(server_url, auth=oauth) as client:
        print("ping:", await client.ping())
        print("time:", await client.call_tool("get_current_time"))
        print("who_am_i:", await client.call_tool("who_am_i"))


if __name__ == "__main__":
    asyncio.run(main())
