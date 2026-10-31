@tool
extends EditorPlugin
## Godot MCP editor bridge.
##
## Opens a loopback-only TCP endpoint (127.0.0.1, random port) and writes the
## port plus a random 256-bit token to res://.godot/godot_mcp/bridge.json
## (owner-only permissions). The godot-mcp server reads that file to connect;
## every connection must authenticate with the token before any request is
## processed. All requests run on the editor main thread (polled from
## _process), so editor APIs are used safely.

const Bridge = preload("bridge_server.gd")

var _bridge: Node


func _enter_tree() -> void:
	_bridge = Bridge.new()
	_bridge.name = "GodotMcpBridge"
	_bridge.plugin = self
	add_child(_bridge)
	var err: int = _bridge.start()
	if err != OK:
		push_warning("Godot MCP bridge failed to start: %s" % error_string(err))


func _exit_tree() -> void:
	if _bridge != null:
		_bridge.stop()
		_bridge.queue_free()
		_bridge = null
