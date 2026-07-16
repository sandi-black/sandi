import os
import runpy
import socket
from pathlib import Path

state_root = os.environ.get("SANDI_MCP_STATE_DIR")
if not state_root:
    raise RuntimeError("SANDI_MCP_STATE_DIR is required for bundled Windows-MCP")

if os.environ.get("SANDI_MCP_OFFLINE_TEST") == "1":
    original_connect = socket.socket.connect

    def offline_connect(self, address):
        if isinstance(address, tuple) and address[0] not in {
            "127.0.0.1",
            "::1",
            "localhost",
        }:
            raise OSError(f"offline MCP verification blocked connection to {address[0]}")
        return original_connect(self, address)

    socket.socket.connect = offline_connect

import comtypes.client

comtypes_dir = Path(state_root) / "comtypes"
comtypes_dir.mkdir(parents=True, exist_ok=True)
comtypes.client.gen_dir = str(comtypes_dir)
runpy.run_module("windows_mcp", run_name="__main__")
