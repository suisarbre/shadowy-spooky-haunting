project(CFS_TMR_CALC C)

# TMR_CALC: a running-sum calculator whose state is kept and computed in three
# TMR partitions, so a bit flip in one copy is voted out and repaired.
add_cfe_app(tmr_calc fsw/src/tmr_calc_app.c)
target_include_directories(tmr_calc PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../libs/tmr_lib/fsw/public_inc)
