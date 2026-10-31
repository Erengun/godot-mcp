extends RefCounted
## Resource inspection, creation and editing (.tres/.res), plus helpers that
## build common native resources: TileSet atlases, SpriteFrames and
## MeshLibrary export.

const U = preload("../../addons/godot_mcp/lib/mcp_util.gd")
const C = preload("../../addons/godot_mcp/lib/variant_codec.gd")
const P = preload("../../addons/godot_mcp/lib/class_policy.gd")


static func ops() -> Dictionary:
	return {
		"resource_inspect": resource_inspect,
		"resource_create": resource_create,
		"resource_edit": resource_edit,
		"tileset_create_atlas": tileset_create_atlas,
		"sprite_frames_create": sprite_frames_create,
		"mesh_library_export": mesh_library_export,
	}


static func _save_and_verify(res: Resource, path: String) -> Variant:
	var dir_err := U.ensure_dir_for(path)
	if dir_err != OK:
		return U.godot_error(dir_err, "Creating directory for " + path)
	var err := U.save_resource(res, path)
	if err != OK:
		return U.godot_error(err, "ResourceSaver.save(%s)" % path)
	var back = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if back == null:
		return U.fail("OPERATION_FAILED", "Saved resource %s could not be reloaded" % path)
	return {"path": path, "class": back.get_class(), "uid": U.uid_text(path)}


static func _check_target(path: String, overwrite: bool) -> Variant:
	if not path.get_extension().to_lower() in ["tres", "res"]:
		return U.fail("INVALID_ARGUMENT", "Resources are saved as .tres (text) or .res (binary): %s" % path)
	if FileAccess.file_exists(path) and not overwrite:
		return U.fail("ALREADY_EXISTS", "%s already exists (pass overwrite: true to replace it)" % path)
	return null


static func describe(res: Resource, depth: int) -> Dictionary:
	var out := {"class": res.get_class(), "path": res.resource_path, "properties": C.stored_properties(res, depth, 128)}
	var s = res.get_script()
	if s is Script:
		out["script"] = s.resource_path
	if res is Texture2D:
		out["size"] = [(res as Texture2D).get_width(), (res as Texture2D).get_height()]
	if res is Mesh:
		out["surface_count"] = (res as Mesh).get_surface_count()
		var aabb := (res as Mesh).get_aabb()
		out["aabb"] = C.encode(aabb)
	if res is PackedScene:
		var st := (res as PackedScene).get_state()
		out["node_count"] = st.get_node_count()
		out["root_type"] = str(st.get_node_type(0)) if st.get_node_count() > 0 else ""
	if res is AudioStream:
		out["length_seconds"] = (res as AudioStream).get_length()
	if res is Animation:
		var tracks := []
		for i in (res as Animation).get_track_count():
			tracks.append({"type": (res as Animation).track_get_type(i), "path": str((res as Animation).track_get_path(i)), "keys": (res as Animation).track_get_key_count(i)})
		out["tracks"] = tracks
	if res is TileSet:
		var sources := []
		for i in (res as TileSet).get_source_count():
			var sid := (res as TileSet).get_source_id(i)
			var src := (res as TileSet).get_source(sid)
			var e := {"id": sid, "class": src.get_class(), "tiles": src.get_tiles_count()}
			if src is TileSetAtlasSource:
				e["texture"] = (src as TileSetAtlasSource).texture.resource_path if (src as TileSetAtlasSource).texture else null
				e["grid"] = C.encode((src as TileSetAtlasSource).get_atlas_grid_size())
			sources.append(e)
		out["sources"] = sources
	if res is MeshLibrary:
		var items := []
		for id in (res as MeshLibrary).get_item_list():
			items.append({"id": id, "name": (res as MeshLibrary).get_item_name(id), "has_mesh": (res as MeshLibrary).get_item_mesh(id) != null})
		out["items"] = items
	return out


static func resource_inspect(args: Dictionary) -> Variant:
	var path = U.to_res_path(args.get("path"))
	if U.is_fail(path):
		return path
	if not ResourceLoader.exists(path):
		if FileAccess.file_exists(path):
			return U.fail("NOT_FOUND", "%s exists on disk but is not a loadable resource (not imported yet? run godot_import)" % path)
		return U.fail("NOT_FOUND", "Resource does not exist: %s" % path)
	var res = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if res == null:
		return U.fail("OPERATION_FAILED", "Failed to load %s (see diagnostics)" % path)
	var out := describe(res, int(args.get("depth", 2)))
	out["path"] = path
	out["dependencies"] = Array(ResourceLoader.get_dependencies(path))
	out["uid"] = U.uid_text(path)
	return out


static func resource_create(args: Dictionary) -> Variant:
	var path = U.to_res_path(args.get("path"))
	if U.is_fail(path):
		return path
	var bad = _check_target(path, bool(args.get("overwrite", false)))
	if bad != null:
		return bad
	var obj = P.create(str(args.get("type", "")), "Resource")
	if U.is_fail(obj):
		return obj
	var props = args.get("properties", {})
	if typeof(props) == TYPE_DICTIONARY:
		for k in props.keys():
			var r = C.set_property(obj, str(k), props[k], {"self_path": path})
			if U.is_fail(r):
				return r
	var saved = _save_and_verify(obj, path)
	if U.is_fail(saved):
		return saved
	saved["properties"] = C.stored_properties(obj, 1, 64)
	return saved


static func resource_edit(args: Dictionary) -> Variant:
	var path = U.to_res_path(args.get("path"))
	if U.is_fail(path):
		return path
	if not path.get_extension().to_lower() in ["tres", "res"]:
		return U.fail("INVALID_ARGUMENT", "Only .tres/.res resources can be edited; imported assets are configured through their .import settings")
	if not FileAccess.file_exists(path):
		return U.fail("NOT_FOUND", "Resource does not exist: %s" % path)
	var res = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if res == null:
		return U.fail("OPERATION_FAILED", "Failed to load %s" % path)
	if res is Script:
		return U.fail("CLASS_NOT_ALLOWED", "Scripts are edited as source files, not as resources")
	res.take_over_path(path)
	var props = args.get("properties", {})
	if typeof(props) != TYPE_DICTIONARY or (props as Dictionary).is_empty():
		return U.fail("INVALID_ARGUMENT", "properties must be a non-empty object")
	var applied := {}
	for k in props.keys():
		var r = C.set_property(res, str(k), props[k], {"self_path": path})
		if U.is_fail(r):
			return r
		applied[k] = r["value"]
	var saved = _save_and_verify(res, path)
	if U.is_fail(saved):
		return saved
	saved["properties"] = applied
	return saved


static func _load_texture(p: Variant) -> Variant:
	var tp = U.to_res_path(p)
	if U.is_fail(tp):
		return tp
	if not ResourceLoader.exists(tp):
		return U.fail("NOT_FOUND", "Texture %s is missing or not imported yet (run godot_import first)" % tp)
	var tex = ResourceLoader.load(tp)
	if not (tex is Texture2D):
		return U.fail("INVALID_ARGUMENT", "%s is not a Texture2D" % tp)
	return tex


static func tileset_create_atlas(args: Dictionary) -> Variant:
	var path = U.to_res_path(args.get("path"))
	if U.is_fail(path):
		return path
	var bad = _check_target(path, bool(args.get("overwrite", false)))
	if bad != null:
		return bad
	var tex = _load_texture(args.get("texture"))
	if U.is_fail(tex):
		return tex
	var tile_size = C.decode(args.get("tile_size", [16, 16]), {"type": TYPE_VECTOR2I})
	if U.is_fail(tile_size) or tile_size.x <= 0 or tile_size.y <= 0:
		return U.fail("INVALID_ARGUMENT", "tile_size must be [w, h] > 0")
	var ts := TileSet.new()
	ts.tile_size = tile_size
	var src := TileSetAtlasSource.new()
	src.texture = tex
	src.texture_region_size = tile_size
	if args.has("margins"):
		var m = C.decode(args["margins"], {"type": TYPE_VECTOR2I})
		if U.is_fail(m):
			return m
		src.margins = m
	if args.has("separation"):
		var s = C.decode(args["separation"], {"type": TYPE_VECTOR2I})
		if U.is_fail(s):
			return s
		src.separation = s
	var source_id := ts.add_source(src, int(args.get("source_id", 0)))
	var grid := src.get_atlas_grid_size()
	var only = args.get("tiles")
	var created := 0
	for x in grid.x:
		for y in grid.y:
			var c := Vector2i(x, y)
			if only != null and typeof(only) == TYPE_ARRAY:
				var wanted := false
				for o in only:
					var oc = C.decode(o, {"type": TYPE_VECTOR2I})
					if not U.is_fail(oc) and oc == c:
						wanted = true
				if not wanted:
					continue
			if src.has_room_for_tile(c, Vector2i.ONE, 1, Vector2i.ZERO, 1):
				src.create_tile(c)
				created += 1
	var collision = args.get("collision")
	if collision != null and str(collision) != "none":
		ts.add_physics_layer()
		if args.has("collision_layer"):
			ts.set_physics_layer_collision_layer(0, int(args["collision_layer"]))
		var half := Vector2(tile_size) / 2.0
		var poly := PackedVector2Array([Vector2(-half.x, -half.y), Vector2(half.x, -half.y), Vector2(half.x, half.y), Vector2(-half.x, half.y)])
		var collide_tiles = args.get("collision_tiles")
		for i in src.get_tiles_count():
			var tc := src.get_tile_id(i)
			if collide_tiles != null and typeof(collide_tiles) == TYPE_ARRAY:
				var hit := false
				for o in collide_tiles:
					var oc = C.decode(o, {"type": TYPE_VECTOR2I})
					if not U.is_fail(oc) and oc == tc:
						hit = true
				if not hit:
					continue
			var td := src.get_tile_data(tc, 0)
			td.add_collision_polygon(0)
			td.set_collision_polygon_points(0, 0, poly)
	var saved = _save_and_verify(ts, path)
	if U.is_fail(saved):
		return saved
	saved["source_id"] = source_id
	saved["atlas_grid"] = C.encode(grid)
	saved["tiles_created"] = created
	saved["physics_layers"] = ts.get_physics_layers_count()
	return saved


static func sprite_frames_create(args: Dictionary) -> Variant:
	var path = U.to_res_path(args.get("path"))
	if U.is_fail(path):
		return path
	var bad = _check_target(path, bool(args.get("overwrite", false)))
	if bad != null:
		return bad
	var tex = _load_texture(args.get("texture"))
	if U.is_fail(tex):
		return tex
	var fs = C.decode(args.get("frame_size"), {"type": TYPE_VECTOR2I})
	if U.is_fail(fs) or fs.x <= 0 or fs.y <= 0:
		return U.fail("INVALID_ARGUMENT", "frame_size must be [w, h] > 0")
	var cols := int((tex as Texture2D).get_width() / fs.x)
	var rows := int((tex as Texture2D).get_height() / fs.y)
	if cols == 0 or rows == 0:
		return U.fail("INVALID_ARGUMENT", "frame_size is larger than the texture (%dx%d)" % [(tex as Texture2D).get_width(), (tex as Texture2D).get_height()])
	var sf := SpriteFrames.new()
	if sf.has_animation("default") and args.get("animations", []).size() > 0:
		sf.remove_animation("default")
	var summary := []
	for anim in args.get("animations", []):
		var name := str(anim.get("name", ""))
		if name.is_empty():
			return U.fail("INVALID_ARGUMENT", "Each animation needs a name")
		sf.add_animation(name)
		sf.set_animation_speed(name, float(anim.get("fps", 8.0)))
		sf.set_animation_loop(name, bool(anim.get("loop", true)))
		for f in anim.get("frames", []):
			var idx := int(f)
			if idx < 0 or idx >= cols * rows:
				return U.fail("INVALID_ARGUMENT", "Frame %d is outside the %dx%d sheet" % [idx, cols, rows])
			var at := AtlasTexture.new()
			at.atlas = tex
			at.region = Rect2(Vector2((idx % cols) * fs.x, (idx / cols) * fs.y), Vector2(fs))
			sf.add_frame(name, at)
		summary.append({"name": name, "frames": sf.get_frame_count(name)})
	var saved = _save_and_verify(sf, path)
	if U.is_fail(saved):
		return saved
	saved["animations"] = summary
	saved["sheet"] = [cols, rows]
	return saved


static func _find_meshes(n: Node, out: Array) -> void:
	if n is MeshInstance3D and (n as MeshInstance3D).mesh != null:
		out.append(n)
		return
	for c in n.get_children():
		_find_meshes(c, out)


static func _find_shapes(n: Node, out: Array, xform: Transform3D) -> void:
	for c in n.get_children():
		if c is CollisionShape3D and (c as CollisionShape3D).shape != null:
			out.append((c as CollisionShape3D).shape)
			out.append(xform * (c as CollisionShape3D).transform)
		if c is Node3D:
			_find_shapes(c, out, xform * (c as Node3D).transform)


static func mesh_library_export(args: Dictionary) -> Variant:
	var sp = U.to_res_path(args.get("scene"))
	if U.is_fail(sp):
		return sp
	var out_path = U.to_res_path(args.get("output"))
	if U.is_fail(out_path):
		return out_path
	if not out_path.get_extension() in ["tres", "res", "meshlib"]:
		return U.fail("INVALID_ARGUMENT", "MeshLibrary output must be .tres, .res or .meshlib")
	var ps = ResourceLoader.load(sp, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if not (ps is PackedScene):
		return U.fail("NOT_FOUND", "Scene not found or invalid: %s" % sp)
	var root: Node = ps.instantiate()
	var only: Array = args.get("items", [])
	var lib := MeshLibrary.new()
	var id := 0
	var items := []
	for child in root.get_children():
		if not only.is_empty() and not str(child.name) in only:
			continue
		var meshes := []
		_find_meshes(child, meshes)
		if meshes.is_empty():
			continue
		var mi: MeshInstance3D = meshes[0]
		lib.create_item(id)
		lib.set_item_name(id, str(child.name))
		lib.set_item_mesh(id, mi.mesh)
		if mi.material_override != null:
			# Bake the override into a duplicate mesh so the library item renders as authored.
			var m: Mesh = mi.mesh.duplicate()
			for s in m.get_surface_count():
				m.surface_set_material(s, mi.material_override)
			lib.set_item_mesh(id, m)
		var shapes := []
		_find_shapes(child, shapes, Transform3D.IDENTITY)
		if not shapes.is_empty():
			lib.set_item_shapes(id, shapes)
		items.append({"id": id, "name": str(child.name), "shapes": shapes.size() / 2})
		id += 1
	root.free()
	if id == 0:
		return U.fail("NOT_FOUND", "No MeshInstance3D with a mesh found under the scene root's children")
	var saved = _save_and_verify(lib, out_path)
	if U.is_fail(saved):
		return saved
	saved["items"] = items
	return saved
