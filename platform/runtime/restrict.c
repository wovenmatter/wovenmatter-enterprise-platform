/* Mandatory second boundary inside the per-execution namespaces. MIT, Woven Matter. */
#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/sched.h>
#define BLOCK(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
int main(int argc,char **argv) {
 if(argc<2 || getuid()!=10001)return 126;
 struct sock_filter filter[]={
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AUDIT_ARCH_X86_64,1,0),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
  /* Deny x32 ABI, which otherwise bypasses syscall-number checks. */
  BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
  /* clone3 hides flags behind a pointer that classic seccomp cannot inspect.
     ENOSYS preserves ordinary libc/Node threads through the clone fallback. */
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone3,0,1),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|ENOSYS),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone,0,3),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
  BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,CLONE_NEWNS|CLONE_NEWUTS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET|CLONE_NEWCGROUP|CLONE_NEWTIME,0,1),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
  BLOCK(mount),BLOCK(umount2),BLOCK(pivot_root),BLOCK(unshare),BLOCK(setns),
  BLOCK(fsopen),BLOCK(fsconfig),BLOCK(fsmount),BLOCK(move_mount),BLOCK(open_tree),BLOCK(mount_setattr),
  BLOCK(ptrace),BLOCK(process_vm_readv),BLOCK(process_vm_writev),BLOCK(bpf),
  BLOCK(perf_event_open),BLOCK(keyctl),BLOCK(add_key),BLOCK(request_key),
  BLOCK(open_by_handle_at),BLOCK(name_to_handle_at),BLOCK(kexec_load),
  BLOCK(reboot),BLOCK(init_module),BLOCK(finit_module),BLOCK(delete_module),
  BLOCK(userfaultfd),BLOCK(io_uring_setup),BLOCK(pidfd_getfd),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
 };
 struct sock_fprog program={.len=sizeof(filter)/sizeof(filter[0]),.filter=filter};
 if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program)){perror("runtime boundary");return 126;}
 execvp(argv[1],argv+1);perror("exec");return 127;
}
