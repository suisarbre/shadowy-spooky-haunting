#!/bin/sh
# Assemble the VM root filesystem (initramfs) from busybox, glibc i386 libs and the cFS install tree.
set -e
W=/home/claude/work
R=$W/vm/rootfs
rm -rf $R && mkdir -p $R/bin $R/sbin $R/usr/bin $R/usr/sbin $R/proc $R/sys $R/dev $R/tmp $R/lib $R/etc
cp $W/busybox-1.36.1/busybox $R/bin/busybox
( cd $R/bin && for a in $(./busybox --list); do [ -e "$a" ] || ln -s busybox "$a"; done )
cp $W/vm/serbridge $W/vm/memmap $R/bin/
cp $W/vm/init $R/init
cp $(dirname "$0")/payload-start $R/bin/payload-start && chmod +x $R/bin/payload-start
# 32-bit glibc runtime needed by core-cpu1, the app .so modules and the helpers.
# Ubuntu's i386 loader searches /lib32, so the libraries live only there; /lib keeps
# just the loader itself, at the interpreter path compiled into every binary.
mkdir -p $R/lib32
for l in ld-linux.so.2 libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 librt.so.1 libgcc_s.so.1; do
  for d in /usr/lib32 /lib32 /usr/lib/gcc/x86_64-linux-gnu/13/32; do [ -e $d/$l ] && cp -L $d/$l $R/lib32/ && break; done
done
cp $R/lib32/ld-linux.so.2 $R/lib/
echo "root:x:0:0:root:/:/bin/sh" > $R/etc/passwd
mkdir -p $R/cfs && cp -a /exe/cpu1 $R/cfs/
# the cFE functional-test app is never started on the flight computer
rm -f $R/cfs/cpu1/cf/cfe_testcase.so
# keep the dynamic symbol tables (cFS looks up entry points and FAULT_INJ uses dlsym), drop debug info
strip --strip-unneeded $R/cfs/cpu1/core-cpu1 $R/cfs/cpu1/cf/*.so 2>/dev/null || true
( cd $R && find . | cpio -o -H newc --quiet | gzip -9 ) > $W/vm/initrd.gz
ls -la $W/vm/initrd.gz
