project(CFS_TMR_LIB C)

# TMR_LIB: software triple modular redundancy. Critical state lives in three
# independent memory partitions; reads vote bit by bit and repair the odd copy out.
add_cfe_app(tmr_lib fsw/src/tmr_lib.c)
target_include_directories(tmr_lib PUBLIC fsw/public_inc)
