import bpy
bpy.ops.file.make_paths_relative()
bpy.ops.wm.save_mainfile(compress=True)
print("RELATIVE", sum(1 for i in bpy.data.images if i.filepath.startswith("//")), "of", len(bpy.data.images))
