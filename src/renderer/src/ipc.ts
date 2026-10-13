// Every Tauri command the UI runs goes through `invoke` here (a policy test
// keeps it so). A command that fails rejects with the error code Rust sends
// as a string, which a handler reading `error.message` takes for no code and
// a crash report for no Error at all. `invoke` turns any rejection into an
// Error whose message is the code alone, so notices, the local log and crash
// reports all get the code. A failure without a code (Tauri's own, such as a
// missing command or arguments that do not fit, whose text can quote what was
// sent) becomes E_COMMAND_FAILED. The rejection itself stays as the Error's
// cause, for the console only: logs and crash reports take codes alone.
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core'
import { errorCode } from '../../core/errors'

export async function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options)
  } catch (error) {
    throw new Error(errorCode(error, 'E_COMMAND_FAILED'), { cause: error })
  }
}
