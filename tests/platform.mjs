/*
 * 测试夹具的平台差异集中处。两处都用 Node 自己的进程/网络原语，让同一套断言
 * 在 POSIX 与 Windows 上跑同样的路径，而不是在测试里按平台分叉。
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/*
 * 用"真 node + 脚本路径"当假 launcher，而不是写一个可执行脚本本身。
 *
 * POSIX 靠 shebang + chmod 0755 就能 spawn 一个无扩展名的脚本；Windows 上
 * 这两样都不成立（CreateProcess 不认 shebang，也没有执行位），假 launcher
 * 一律起不来、用例全部报 LAUNCHER_MISSING——那是夹具的假失败，不是被测代码
 * 的问题。直接让 node 可执行文件跑同一个脚本，两边走的是同一条 spawn 路径。
 *
 * argv 只被测试用来数"假 launcher 被调了几次"，所以 relocatable 与否不影响断言。
 */
export function fakeCliCommand(launcher) {
  return { command: process.execPath, args: [launcher] }
}

let socketCounter = 0

/*
 * 假 Runtime Service 的监听地址。真服务端本身就是两条传输：POSIX 上是 unix
 * domain socket（路径上限约 104 字节，所以用短名直接放 tmpdir 根、不进
 * mkdtemp 子目录），Windows 上是 named pipe。Node 的 net.createServer 对两者
 * 是同一个 API，被测的 endpoint.ts 也是把 address 原样交给 net.createConnection，
 * 所以夹具只要给出对平台合法的地址即可。
 */
export function fakeServiceAddress() {
  const name = `dsh-tabbit-ep-${process.pid}-${socketCounter++}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`
  return join(tmpdir(), `${name}.sock`)
}
