#!/bin/sh
# Assemble the VM root filesystem (initramfs) from busybox, glibc i386 libs and the cFS install tree.
set -e
W=/home/claude/work
R=$W/vm/rootfs
rm -rf $R && mkdir -p $R/bin $R/sbin $R/usr/bin $R/usr/sbin $R/proc $R/sys $R/dev $R/tmp $R/lib $R/etc
cp $W/busybox-1.36.1/busybox $R/bin/busybox
( cd $R/bin && for a in $(./busybox --list); do [ -e "$a" ] || ln -s busybox "$a"; done )
cp $W/vm/serbridge $R/bin/
cp $W/vm/init $R/init
# 32-bit glibc runtime needed by core-cpu1 and the app .so modules
for l in ld-linux.so.2 libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 librt.so.1 libgcc_s.so.1; do
  for d in /usr/lib32 /lib32 /usr/lib/gcc/x86_64-linux-gnu/13/32; do [ -e $d/$l ] && cp -L $d/$l $R/lib/ && break; done
done
mkdir -p $R/lib32 && cp $R/lib/* $R/lib32/ 2>/dev/null || true
echo "root:x:0:0:root:/:/bin/sh" > $R/etc/passwd
mkdir -p $R/cfs && cp -a /exe/cpu1 $R/cfs/
( cd $R && find . | cpio -o -H newc --quiet | gzip -9 ) > $W/vm/initrd.gz
ls -la $W/vm/initrd.gz
