project(CFS_FAULT_INJ C)

# FAULT_INJ: simulates radiation upsets by flipping bits in other apps' memory.
add_cfe_app(fault_inj fsw/src/fault_inj_app.c)
target_include_directories(fault_inj PUBLIC fsw/src)
# to aim at one copy of a TMR region (resolved at run time, so TMR_LIB stays optional)
target_include_directories(fault_inj PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../libs/tmr_lib/fsw/public_inc)
