project(CFS_FAULT_INJ C)

# FAULT_INJ: simulates radiation upsets by flipping bits in other apps' memory.
add_cfe_app(fault_inj fsw/src/fault_inj_app.c)
target_include_directories(fault_inj PUBLIC fsw/src)
