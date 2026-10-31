extends RefCounted
## Native authoring actions used inside scene_edit batches:
## AnimationPlayer animations/tracks/keys, TileMapLayer cells and GridMap cells.
## All of them operate on real engine resources (Animation, AnimationLibrary,
## TileSet, MeshLibrary) — nothing is emulated with scripts.

const U = preload("../../addons/godot_mcp/lib/mcp_util.gd")
const C = preload("../../addons/godot_mcp/lib/variant_codec.gd")

const ACTIONS := ["animation_upsert", "animation_remove", "animation_keys", "tilemap_set_cells", "tilemap_erase_cells", "tilemap_fill_rect", "gridmap_set_cells", "gridmap_clear_cells"]

const TRACK_TYPES := {
	"value": Animation.TYPE_VALUE, "position_3d": Animation.TYPE_POSITION_3D,
	"rotation_3d": Animation.TYPE_ROTATION_3D, "scale_3d": Animation.TYPE_SCALE_3D,
	"blend_shape": Animation.TYPE_BLEND_SHAPE, "method": Animation.TYPE_METHOD,
	"bezier": Animation.TYPE_BEZIER, "audio": Animation.TYPE_AUDIO, "animation": Animation.TYPE_ANIMATION,
}
const INTERP := {"nearest": Animation.INTERPOLATION_NEAREST, "linear": Animation.INTERPOLATION_LINEAR, "cubic": Animation.INTERPOLATION_CUBIC, "linear_angle": Animation.INTERPOLATION_LINEAR_ANGLE, "cubic_angle": Animation.INTERPOLATION_CUBIC_ANGLE}
const UPDATE := {"continuous": Animation.UPDATE_CONTINUOUS, "discrete": Animation.UPDATE_DISCRETE, "capture": Animation.UPDATE_CAPTURE}
const LOOP := {"none": Animation.LOOP_NONE, "linear": Animation.LOOP_LINEAR, "pingpong": Animation.LOOP_PINGPONG}


static func handles(kind: String) -> bool:
	return kind in ACTIONS


static func apply(root: Node, kind: String, a: Dictionary, ctx: Dictionary) -> Variant:
	match kind:
		"animation_upsert": return _anim_upsert(root, a, ctx)
		"animation_remove": return _anim_remove(root, a, ctx)
		"animation_keys": return _anim_keys(root, a, ctx)
		"tilemap_set_cells": return _tm_set(root, a)
		"tilemap_erase_cells": return _tm_erase(root, a)
		"tilemap_fill_rect": return _tm_fill(root, a)
		"gridmap_set_cells": return _gm_set(root, a)
		"gridmap_clear_cells": return _gm_clear(root, a)
	return U.fail("INVALID_ARGUMENT", "Unknown authoring action " + kind)


static func _node(root: Node, a: Dictionary, key: String, cls: String) -> Variant:
	var p = a.get(key, ".")
	var n := U.find_node(root, p)
	if n == null:
		return U.fail("NOT_FOUND", "Node not found: %s" % p)
	if not n.is_class(cls):
		return U.fail("INVALID_ARGUMENT", "Node '%s' is a %s, expected %s" % [p, n.get_class(), cls])
	return n


# ------------------------------------------------------------ animation

static func _library(player: AnimationMixer, lib_name: String, create: bool) -> Variant:
	if player.has_animation_library(lib_name):
		var lib := player.get_animation_library(lib_name)
		if C.is_external_resource(lib):
			return U.fail("CONFLICT", "Animation library '%s' is the external resource %s; edit that resource file instead" % [lib_name, lib.resource_path])
		return lib
	if not create:
		return U.fail("NOT_FOUND", "AnimationPlayer has no library '%s'" % lib_name)
	var nl := AnimationLibrary.new()
	var err := player.add_animation_library(lib_name, nl)
	if err != OK:
		return U.godot_error(err, "add_animation_library")
	return nl


static func _track_target_info(player: AnimationMixer, path: NodePath) -> Variant:
	var base: Node = player.get_node_or_null(player.root_node)
	if base == null:
		return U.fail("NOT_FOUND", "AnimationPlayer root_node %s does not resolve" % player.root_node)
	var node_part := NodePath(str(path).get_slice(":", 0)) if str(path).contains(":") else path
	var target := base.get_node_or_null(node_part)
	if target == null:
		return U.fail("NOT_FOUND", "Track path '%s' does not resolve to a node (relative to %s)" % [path, base.name])
	return target


static func _decode_key_value(player: AnimationMixer, track: Dictionary, path: NodePath, ttype: int, value: Variant) -> Variant:
	match ttype:
		Animation.TYPE_POSITION_3D, Animation.TYPE_SCALE_3D:
			return C.decode(value, {"type": TYPE_VECTOR3})
		Animation.TYPE_ROTATION_3D:
			return C.decode(value, {"type": TYPE_QUATERNION})
		Animation.TYPE_BLEND_SHAPE, Animation.TYPE_BEZIER:
			return C.decode(value, {"type": TYPE_FLOAT})
		Animation.TYPE_VALUE:
			var target = _track_target_info(player, path)
			if U.is_fail(target):
				return target
			var sub := str(path).get_slice(":", 1) if str(path).contains(":") else ""
			if sub.is_empty():
				return U.fail("INVALID_ARGUMENT", "Value track path must include a property, e.g. 'Sprite2D:position'")
			var resolved = C.resolve_target(target, sub.replace(":", ":"))
			var info := C.property_info(resolved[0], resolved[1]) if not U.is_fail(resolved) else {}
			if info.is_empty():
				return U.fail("NOT_FOUND", "Track property '%s' does not exist on %s" % [sub, (target as Node).get_class()])
			return C.decode(value, info, {"node": target})
	return C.decode(value)


static func _insert_keys(player: AnimationMixer, anim: Animation, idx: int, track_spec: Dictionary, keys: Array) -> Variant:
	var ttype := anim.track_get_type(idx)
	var path := anim.track_get_path(idx)
	var inserted := 0
	for k in keys:
		if typeof(k) != TYPE_DICTIONARY or not k.has("time"):
			return U.fail("INVALID_ARGUMENT", "Each key needs at least {time}")
		var t := float(k["time"])
		if t < 0.0 or t > anim.length + 0.00001:
			return U.fail("INVALID_ARGUMENT", "Key time %s is outside the animation length %s" % [t, anim.length])
		match ttype:
			Animation.TYPE_METHOD:
				var m := str(k.get("method", ""))
				if not m.is_valid_identifier():
					return U.fail("INVALID_ARGUMENT", "Method keys need a valid 'method'")
				var margs = C.decode(k.get("args", []), {"type": TYPE_ARRAY})
				if U.is_fail(margs):
					return margs
				anim.track_insert_key(idx, t, {"method": StringName(m), "args": margs})
			Animation.TYPE_BEZIER:
				var bv = _decode_key_value(player, track_spec, path, ttype, k.get("value"))
				if U.is_fail(bv):
					return bv
				var ih = C.decode(k.get("in_handle", [-0.25, 0]), {"type": TYPE_VECTOR2})
				var oh = C.decode(k.get("out_handle", [0.25, 0]), {"type": TYPE_VECTOR2})
				if U.is_fail(ih) or U.is_fail(oh):
					return U.fail("INVALID_ARGUMENT", "Bezier handles must be [x, y]")
				anim.bezier_track_insert_key(idx, t, bv, ih, oh)
			_:
				if not k.has("value"):
					return U.fail("INVALID_ARGUMENT", "Key at %s has no value" % t)
				var v = _decode_key_value(player, track_spec, path, ttype, k["value"])
				if U.is_fail(v):
					return v
				anim.track_insert_key(idx, t, v, float(k.get("transition", 1.0)))
		inserted += 1
	return inserted


static func _anim_upsert(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var player = _node(root, a, "player", "AnimationMixer")
	if U.is_fail(player):
		return player
	var lib = _library(player, str(a.get("library", "")), true)
	if U.is_fail(lib):
		return lib
	var name := str(a.get("name", ""))
	if name.is_empty() or name.contains("/") or name.contains(":") or name.contains(","):
		return U.fail("INVALID_ARGUMENT", "Animation name must be non-empty and must not contain / : ,")
	var anim: Animation
	var created := false
	if (lib as AnimationLibrary).has_animation(name) and not bool(a.get("replace", false)):
		anim = (lib as AnimationLibrary).get_animation(name)
		if C.is_external_resource(anim):
			return U.fail("CONFLICT", "Animation '%s' is stored in %s; edit that resource instead" % [name, anim.resource_path])
	else:
		anim = Animation.new()
		created = true
	if a.has("length"):
		anim.length = maxf(0.001, float(a["length"]))
	if a.has("loop_mode"):
		if not LOOP.has(str(a["loop_mode"])):
			return U.fail("INVALID_ARGUMENT", "loop_mode must be one of %s" % ", ".join(LOOP.keys()))
		anim.loop_mode = LOOP[str(a["loop_mode"])]
	if a.has("step"):
		anim.step = float(a["step"])
	var track_results := []
	for spec in a.get("tracks", []):
		if typeof(spec) != TYPE_DICTIONARY:
			return U.fail("INVALID_ARGUMENT", "tracks[] entries must be objects")
		var tname := str(spec.get("type", "value"))
		if not TRACK_TYPES.has(tname):
			return U.fail("INVALID_ARGUMENT", "Track type must be one of %s" % ", ".join(TRACK_TYPES.keys()))
		var path := NodePath(str(spec.get("path", "")))
		if path.is_empty():
			return U.fail("INVALID_ARGUMENT", "Track path is required (e.g. 'Sprite2D:position' or 'Body' for 3D transform tracks)")
		var target = _track_target_info(player, path)
		if U.is_fail(target):
			return target
		var ttype: int = TRACK_TYPES[tname]
		var idx := anim.find_track(path, ttype)
		if idx < 0:
			idx = anim.add_track(ttype)
			anim.track_set_path(idx, path)
		elif bool(spec.get("replace_keys", true)):
			while anim.track_get_key_count(idx) > 0:
				anim.track_remove_key(idx, 0)
		if spec.has("interpolation"):
			if not INTERP.has(str(spec["interpolation"])):
				return U.fail("INVALID_ARGUMENT", "interpolation must be one of %s" % ", ".join(INTERP.keys()))
			anim.track_set_interpolation_type(idx, INTERP[str(spec["interpolation"])])
		if spec.has("update_mode") and ttype == Animation.TYPE_VALUE:
			if not UPDATE.has(str(spec["update_mode"])):
				return U.fail("INVALID_ARGUMENT", "update_mode must be one of %s" % ", ".join(UPDATE.keys()))
			anim.value_track_set_update_mode(idx, UPDATE[str(spec["update_mode"])])
		var n = _insert_keys(player, anim, idx, spec, spec.get("keys", []))
		if U.is_fail(n):
			return n
		track_results.append({"index": idx, "type": tname, "path": str(path), "keys": anim.track_get_key_count(idx)})
	if created:
		if (lib as AnimationLibrary).has_animation(name):
			(lib as AnimationLibrary).remove_animation(name)
		var err := (lib as AnimationLibrary).add_animation(name, anim)
		if err != OK:
			return U.godot_error(err, "add_animation")
	var full := name if str(a.get("library", "")).is_empty() else "%s/%s" % [a.get("library"), name]
	if bool(a.get("autoplay", false)) and player is AnimationPlayer:
		(player as AnimationPlayer).autoplay = full
	return {"action": "animation_upsert", "animation": full, "created": created, "length": anim.length, "loop_mode": anim.loop_mode, "tracks": track_results, "track_count": anim.get_track_count()}


static func _get_anim(root: Node, a: Dictionary) -> Variant:
	var player = _node(root, a, "player", "AnimationMixer")
	if U.is_fail(player):
		return player
	var lib = _library(player, str(a.get("library", "")), false)
	if U.is_fail(lib):
		return lib
	var name := str(a.get("name", ""))
	if not (lib as AnimationLibrary).has_animation(name):
		return U.fail("NOT_FOUND", "Animation '%s' not found; available: %s" % [name, ", ".join((lib as AnimationLibrary).get_animation_list())])
	var anim := (lib as AnimationLibrary).get_animation(name)
	if C.is_external_resource(anim):
		return U.fail("CONFLICT", "Animation '%s' is stored in %s; edit that resource instead" % [name, anim.resource_path])
	return [player, lib, anim]


static func _anim_remove(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var got = _get_anim(root, a)
	if U.is_fail(got):
		return got
	(got[1] as AnimationLibrary).remove_animation(str(a.get("name")))
	return {"action": "animation_remove", "name": a.get("name")}


static func _anim_keys(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var got = _get_anim(root, a)
	if U.is_fail(got):
		return got
	var player: AnimationMixer = got[0]
	var anim: Animation = got[2]
	var idx := -1
	var tr = a.get("track")
	if typeof(tr) in [TYPE_INT, TYPE_FLOAT]:
		idx = int(tr)
	else:
		for i in anim.get_track_count():
			if str(anim.track_get_path(i)) == str(tr):
				idx = i
				break
	if idx < 0 or idx >= anim.get_track_count():
		return U.fail("NOT_FOUND", "Track '%s' not found" % tr)
	var removed := 0
	for t in a.get("remove_times", []):
		var k := anim.track_find_key(idx, float(t), Animation.FIND_MODE_APPROX)
		if k < 0:
			return U.fail("NOT_FOUND", "No key at time %s" % t)
		anim.track_remove_key(idx, k)
		removed += 1
	var inserted = _insert_keys(player, anim, idx, {}, a.get("insert", []))
	if U.is_fail(inserted):
		return inserted
	return {"action": "animation_keys", "track": idx, "inserted": inserted, "removed": removed, "key_count": anim.track_get_key_count(idx)}


# ------------------------------------------------------------ TileMapLayer

static func _tile_layer(root: Node, a: Dictionary) -> Variant:
	var layer = _node(root, a, "node", "TileMapLayer")
	if U.is_fail(layer):
		return layer
	if (layer as TileMapLayer).tile_set == null:
		return U.fail("INVALID_ARGUMENT", "TileMapLayer '%s' has no tile_set; assign one first" % a.get("node"))
	return layer


static func _check_tile(ts: TileSet, source_id: int, atlas: Vector2i, alt: int) -> String:
	if not ts.has_source(source_id):
		return "TileSet has no source id %d" % source_id
	var src := ts.get_source(source_id)
	if src is TileSetAtlasSource:
		if not (src as TileSetAtlasSource).has_tile(atlas):
			return "Atlas source %d has no tile at %s (grid %s)" % [source_id, atlas, (src as TileSetAtlasSource).get_atlas_grid_size()]
		if not (src as TileSetAtlasSource).has_alternative_tile(atlas, alt):
			return "Tile %s has no alternative %d" % [atlas, alt]
	return ""


static func _tm_set(root: Node, a: Dictionary) -> Variant:
	var layer = _tile_layer(root, a)
	if U.is_fail(layer):
		return layer
	var ts: TileSet = (layer as TileMapLayer).tile_set
	var cells = a.get("cells", [])
	if typeof(cells) != TYPE_ARRAY or (cells as Array).size() > 100000:
		return U.fail("INVALID_ARGUMENT", "cells must be an array (max 100000)")
	var count := 0
	for c in cells:
		var coords = C.decode(c.get("coords"), {"type": TYPE_VECTOR2I})
		var atlas = C.decode(c.get("atlas_coords", a.get("atlas_coords", [0, 0])), {"type": TYPE_VECTOR2I})
		if U.is_fail(coords) or U.is_fail(atlas):
			return U.fail("INVALID_ARGUMENT", "Each cell needs coords [x, y] and atlas_coords [x, y]")
		var sid := int(c.get("source_id", a.get("source_id", 0)))
		var alt := int(c.get("alternative", a.get("alternative", 0)))
		var why := _check_tile(ts, sid, atlas, alt)
		if not why.is_empty():
			return U.fail("INVALID_ARGUMENT", why)
		(layer as TileMapLayer).set_cell(coords, sid, atlas, alt)
		count += 1
	return {"action": "tilemap_set_cells", "cells_set": count, "used_cells": (layer as TileMapLayer).get_used_cells().size()}


static func _tm_erase(root: Node, a: Dictionary) -> Variant:
	var layer = _tile_layer(root, a)
	if U.is_fail(layer):
		return layer
	var count := 0
	for c in a.get("cells", []):
		var coords = C.decode(c, {"type": TYPE_VECTOR2I})
		if U.is_fail(coords):
			return coords
		(layer as TileMapLayer).erase_cell(coords)
		count += 1
	return {"action": "tilemap_erase_cells", "cells_erased": count, "used_cells": (layer as TileMapLayer).get_used_cells().size()}


static func _tm_fill(root: Node, a: Dictionary) -> Variant:
	var layer = _tile_layer(root, a)
	if U.is_fail(layer):
		return layer
	var rect = C.decode(a.get("rect"), {"type": TYPE_RECT2I})
	if U.is_fail(rect):
		return rect
	if rect.size.x * rect.size.y > 100000:
		return U.fail("INVALID_ARGUMENT", "Rect too large (max 100000 cells)")
	var atlas = C.decode(a.get("atlas_coords", [0, 0]), {"type": TYPE_VECTOR2I})
	if U.is_fail(atlas):
		return atlas
	var sid := int(a.get("source_id", 0))
	var alt := int(a.get("alternative", 0))
	var why := _check_tile((layer as TileMapLayer).tile_set, sid, atlas, alt)
	if not why.is_empty():
		return U.fail("INVALID_ARGUMENT", why)
	for x in range(rect.position.x, rect.position.x + rect.size.x):
		for y in range(rect.position.y, rect.position.y + rect.size.y):
			(layer as TileMapLayer).set_cell(Vector2i(x, y), sid, atlas, alt)
	return {"action": "tilemap_fill_rect", "cells_set": rect.size.x * rect.size.y, "used_cells": (layer as TileMapLayer).get_used_cells().size()}


# ------------------------------------------------------------ GridMap

static func _gm_set(root: Node, a: Dictionary) -> Variant:
	var gm = _node(root, a, "node", "GridMap")
	if U.is_fail(gm):
		return gm
	var lib: MeshLibrary = (gm as GridMap).mesh_library
	if lib == null:
		return U.fail("INVALID_ARGUMENT", "GridMap has no mesh_library; assign one first")
	var count := 0
	for c in a.get("cells", []):
		var pos = C.decode(c.get("position"), {"type": TYPE_VECTOR3I})
		if U.is_fail(pos):
			return pos
		var item = c.get("item", 0)
		var id := -1
		if typeof(item) == TYPE_STRING:
			id = lib.find_item_by_name(item)
		else:
			id = int(item)
		if id < 0 or not lib.get_item_list().has(id):
			return U.fail("NOT_FOUND", "MeshLibrary has no item %s (items: %s)" % [item, lib.get_item_list()])
		(gm as GridMap).set_cell_item(pos, id, int(c.get("orientation", 0)))
		count += 1
	return {"action": "gridmap_set_cells", "cells_set": count, "used_cells": (gm as GridMap).get_used_cells().size()}


static func _gm_clear(root: Node, a: Dictionary) -> Variant:
	var gm = _node(root, a, "node", "GridMap")
	if U.is_fail(gm):
		return gm
	var count := 0
	for c in a.get("cells", []):
		var pos = C.decode(c, {"type": TYPE_VECTOR3I})
		if U.is_fail(pos):
			return pos
		(gm as GridMap).set_cell_item(pos, GridMap.INVALID_CELL_ITEM)
		count += 1
	return {"action": "gridmap_clear_cells", "cells_cleared": count}
