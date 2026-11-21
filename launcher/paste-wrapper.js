/**
 * Triage Desk launcher — the paste wrapper: runs an agent inside a pseudo
 * terminal and types the prompt into its input box as one bracketed paste,
 * without pressing Enter, so the user reviews it and sends it themselves.
 *
 * The same state machine has two implementations:
 *   - POSIX (macOS, Linux): Python 3 with the standard `pty` module;
 *   - Windows: C# over ConPTY (Windows 10 1809+), compiled by PowerShell 5.1
 *     `Add-Type` at launch.
 *
 * Rules shared by both (and by dev/smoke-paste.mjs, which checks them on all
 * three platforms with a fake agent):
 *   1. The agent is ready for a paste once it turns bracketed paste on
 *      (`CSI ? 2004 h`, which every supported TUI emits at start) and its output
 *      has been quiet for QUIET_MS, or SETTLE_MS have passed since then: Codex
 *      animates its start screen without pause, so it is never quiet.
 *   2. A folder-trust dialog on screen (TRUST_PATTERN) holds the paste until the
 *      user presses Enter. Any Enter before the paste forgets the screen seen so
 *      far (so a dialog accepted before it was noticed cannot hold the paste)
 *      and starts the readiness wait of rule 1 again.
 *   3. The paste is `ESC [200~` + prompt + `ESC [201~`; ESC and other control
 *      characters except newline and tab are removed from the prompt first, so
 *      it cannot end the paste early or send keys.
 *   4. No paste after DEADLINE_MS; the prompt is still on the clipboard.
 *   5. Everything else is passed through unchanged, the window size follows the
 *      real terminal, and the wrapper exits with the agent's exit status.
 */

export const PASTE_QUIET_MS = 700
export const PASTE_SETTLE_MS = 2500
export const PASTE_DEADLINE_MS = 120_000

/**
 * Folder-trust prompts of the supported agents, checked on 2026-11-19: Claude
 * Code "Is this a project you created or one you trust?", Codex "Trust this
 * folder?", Antigravity "Do you trust the contents of this project?", Gemini
 * CLI "Do you trust this folder?".
 */
export const PASTE_TRUST_PATTERN =
  "(?i)(trust this (folder|project|directory|workspace)|do you trust|one you trust|trust the (contents|files))"

/** Control characters removed from a prompt before it is pasted (keeps \t and \n). */
export function sanitizePastePrompt(prompt) {
  return String(prompt)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
}

/** Python 3 (stdlib only) implementation for macOS and Linux. Run with `python3 -I`. */
export const PASTE_WRAPPER_PY = String.raw`# Triage Desk paste wrapper (generated for this launch; safe to delete).
# Usage: python3 -I <this file> <prompt file> <argv...>
import os, re, select, signal, struct, sys, time
import fcntl, pty, termios, tty

QUIET = ${PASTE_QUIET_MS} / 1000.0
SETTLE = ${PASTE_SETTLE_MS} / 1000.0
DEADLINE = ${PASTE_DEADLINE_MS} / 1000.0
TRUST = re.compile(r"${PASTE_TRUST_PATTERN.replace('(?i)', '')}", re.I)
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]")
PASTE_ON = b"\x1b[?2004h"
PASTE_OFF = b"\x1b[?2004l"


def read_prompt(path):
    try:
        with open(path, "rb") as handle:
            data = handle.read().decode("utf-8", "replace")
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return data.encode("utf-8")


def window_size(fd):
    try:
        rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
        if rows and cols:
            return rows, cols
    except OSError:
        pass
    return 40, 120


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        try:
            written = os.write(fd, data)
        except InterruptedError:
            continue
        data = data[written:]


def main():
    remote = sys.argv[1] == "--remote"
    args = sys.argv[2:] if remote else sys.argv[1:]
    prompt = read_prompt(args[0])
    argv = args[1:]
    stdin_tty = os.isatty(0)
    rows, cols = window_size(0 if stdin_tty else 1)
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except OSError as error:
            sys.stderr.write("Triage Desk: could not start %s: %s\n" % (argv[0], error))
        os._exit(127)
    set_size(master, rows, cols)

    def on_winch(_signum, _frame):
        if stdin_tty:
            set_size(master, *window_size(0))

    signal.signal(signal.SIGWINCH, on_winch)
    saved = None
    if stdin_tty:
        saved = termios.tcgetattr(0)
        tty.setraw(0)

    start = time.monotonic()
    last_output = start
    paste_mode = False
    ready_since = None
    waiting_for_user = False
    pasted = not prompt
    tail = b""
    screen = ""
    stdin_open = True
    try:
        while True:
            readers = [master] + ([0] if stdin_open else [])
            try:
                ready, _, _ = select.select(readers, [], [], 0.05)
            except InterruptedError:
                continue
            now = time.monotonic()
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                write_all(1, data)
                last_output = now
                if not pasted:
                    window = tail + data
                    on, off = window.rfind(PASTE_ON), window.rfind(PASTE_OFF)
                    if on != -1 or off != -1:
                        paste_mode = on > off
                        if paste_mode and ready_since is None:
                            ready_since = now
                    tail = window[-16:]
                    screen = (screen + ANSI.sub(b"", data).decode("utf-8", "replace"))[-6000:]
            if 0 in ready:
                try:
                    data = os.read(0, 65536)
                except OSError:
                    data = b""
                if not data:
                    stdin_open = False
                else:
                    write_all(master, data)
                    if not pasted and (b"\r" in data or b"\n" in data):
                        if remote and waiting_for_user:
                            start = now
                        waiting_for_user = False
                        screen = ""
                        last_output = now
                        ready_since = now
            if not pasted:
                if now - start > DEADLINE and not (remote and waiting_for_user):
                    if remote:
                        write_all(2, b"\r\nTriage Desk: the agent did not accept the draft. Use Copy prompt in the panel and paste it here.\r\n")
                    pasted = True
                elif paste_mode and not waiting_for_user and (
                    now - last_output >= QUIET or now - ready_since >= SETTLE
                ):
                    if TRUST.search(screen):
                        waiting_for_user = True
                    else:
                        write_all(master, b"\x1b[200~" + prompt + b"\x1b[201~")
                        pasted = True
    finally:
        if saved is not None:
            termios.tcsetattr(0, termios.TCSAFLUSH, saved)
    _, status = os.waitpid(pid, 0)
    if remote and not pasted:
        sys.stderr.write("Triage Desk: the agent closed before accepting the draft. Use Copy prompt in the panel or retry.\n")
        if status == 0:
            return 1
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


if __name__ == "__main__":
    sys.exit(main())
`

/**
 * C# implementation for Windows (ConPTY), compiled by PowerShell 5.1
 * `Add-Type`, so it targets C# 5 / .NET Framework 4.5. Entry point:
 * `[TriageDesk.PasteHost]::Run(commandLine, promptFile, cwd)` returns the
 * agent's exit code, or throws when ConPTY is unavailable (the launcher then
 * falls back to the clipboard).
 *
 * API facts (learn.microsoft.com, "Creating a Pseudoconsole session"):
 * CreatePseudoConsole needs Windows 10 1809; the child is started with
 * EXTENDED_STARTUPINFO_PRESENT and PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
 * (0x20016); STARTF_USESTDHANDLES with null handles keeps a redirected parent's
 * stdio out of the child; closing the pseudoconsole ends the output stream.
 */
export const PASTE_WRAPPER_CS = String.raw`using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace TriageDesk
{
    public static class PasteHost
    {
        const int QuietMs = ${PASTE_QUIET_MS};
        const int SettleMs = ${PASTE_SETTLE_MS};
        const int DeadlineMs = ${PASTE_DEADLINE_MS};
        static readonly Regex Trust = new Regex(@"${PASTE_TRUST_PATTERN.replace('(?i)', '')}", RegexOptions.IgnoreCase);
        static readonly Regex Ansi = new Regex(@"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]");

        [StructLayout(LayoutKind.Sequential)]
        struct Coord { public short X; public short Y; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct StartupInfo
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX; public int dwY; public int dwXSize; public int dwYSize;
            public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
            public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
            public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr lpAttributeList; }

        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInformation { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

        [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
        struct KeyEventRecord
        {
            [FieldOffset(0)] public int bKeyDown;
            [FieldOffset(4)] public short wRepeatCount;
            [FieldOffset(6)] public short wVirtualKeyCode;
            [FieldOffset(8)] public short wVirtualScanCode;
            [FieldOffset(10)] public char UnicodeChar;
            [FieldOffset(12)] public int dwControlKeyState;
        }

        [StructLayout(LayoutKind.Explicit)]
        struct InputRecord
        {
            [FieldOffset(0)] public short EventType;
            [FieldOffset(4)] public KeyEventRecord KeyEvent;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern int ResizePseudoConsole(IntPtr console, Coord size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern void ClosePseudoConsole(IntPtr console);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
            bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo, out ProcessInformation information);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr GetStdHandle(int which);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetConsoleMode(IntPtr handle, out uint mode);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetConsoleMode(IntPtr handle, uint mode);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetNumberOfConsoleInputEvents(IntPtr handle, out uint count);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ReadConsoleInputW")]
        static extern bool ReadConsoleInput(IntPtr handle, [Out] InputRecord[] records, uint length, out uint read);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "PeekConsoleInputW")]
        static extern bool PeekConsoleInput(IntPtr handle, [Out] InputRecord[] records, uint length, out uint read);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ReadConsoleW")]
        static extern bool ReadConsole(IntPtr handle, [Out] char[] buffer, uint toRead, out uint read, IntPtr inputControl);

        const int StdInput = -10, StdOutput = -11;
        const uint EnableVirtualTerminalInput = 0x0200;
        const uint EnableProcessedOutput = 0x0001, EnableVirtualTerminalProcessing = 0x0004, DisableNewlineAutoReturn = 0x0008;
        const uint ExtendedStartupInfoPresent = 0x00080000;
        const int StartfUseStdHandles = 0x00000100;
        static readonly IntPtr PseudoConsoleAttribute = new IntPtr(0x00020016);

        static readonly object Gate = new object();
        static Stream ptyInput;
        static volatile bool finished;
        static bool pasteMode, waitingForUser, pasted;
        static long lastOutput, started, readySince = -1;
        static string screen = "";
        static string tail = "";
        static byte[] paste;

        static long Now() { return Environment.TickCount & 0x7fffffffL; }

        static Coord WindowSize()
        {
            try { return new Coord { X = (short)Math.Max(Console.WindowWidth, 20), Y = (short)Math.Max(Console.WindowHeight, 5) }; }
            catch (IOException) { return new Coord { X = 120, Y = 40 }; }
        }

        static void SendToAgent(byte[] data)
        {
            lock (Gate) { ptyInput.Write(data, 0, data.Length); ptyInput.Flush(); }
        }

        public static int Run(string commandLine, string promptFile, string cwd)
        {
            string prompt = File.ReadAllText(promptFile, Encoding.UTF8);
            try { File.Delete(promptFile); } catch (IOException) { }
            paste = Encoding.UTF8.GetBytes("\x1b[200~" + prompt + "\x1b[201~");
            pasted = prompt.Length == 0;

            SafeFileHandle inputRead, inputWrite, outputRead, outputWrite;
            if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0) || !CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0))
                throw new InvalidOperationException("CreatePipe failed: " + Marshal.GetLastWin32Error());
            IntPtr console;
            int hr = CreatePseudoConsole(WindowSize(), inputRead, outputWrite, 0, out console);
            if (hr != 0) throw new InvalidOperationException("CreatePseudoConsole failed: 0x" + hr.ToString("x8"));
            inputRead.Dispose();
            outputWrite.Dispose();

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            IntPtr list = Marshal.AllocHGlobal(size);
            ProcessInformation process;
            try
            {
                if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
                    throw new InvalidOperationException("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
                if (!UpdateProcThreadAttribute(list, 0, PseudoConsoleAttribute, console, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                    throw new InvalidOperationException("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
                var startup = new StartupInfoEx();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.StartupInfo.dwFlags = StartfUseStdHandles;
                startup.lpAttributeList = list;
                if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, ExtendedStartupInfoPresent,
                        IntPtr.Zero, cwd, ref startup, out process))
                    throw new InvalidOperationException("CreateProcess failed: " + Marshal.GetLastWin32Error());
            }
            finally
            {
                DeleteProcThreadAttributeList(list);
                Marshal.FreeHGlobal(list);
            }

            ptyInput = new FileStream(inputWrite, FileAccess.Write);
            IntPtr stdin = GetStdHandle(StdInput), stdout = GetStdHandle(StdOutput);
            uint savedIn, savedOut;
            bool inConsole = GetConsoleMode(stdin, out savedIn);
            bool outConsole = GetConsoleMode(stdout, out savedOut);
            if (inConsole) SetConsoleMode(stdin, EnableVirtualTerminalInput);
            if (outConsole) SetConsoleMode(stdout, savedOut | EnableProcessedOutput | EnableVirtualTerminalProcessing | DisableNewlineAutoReturn);
            Encoding savedOutputEncoding = Console.OutputEncoding;
            if (outConsole) Console.OutputEncoding = new UTF8Encoding(false);
            started = Now();
            lastOutput = started;

            var output = new Thread(() => PumpOutput(new FileStream(outputRead, FileAccess.Read), Console.OpenStandardOutput()));
            output.IsBackground = true;
            output.Start();
            var input = new Thread(() => { if (inConsole) PumpConsoleInput(stdin); else PumpStreamInput(Console.OpenStandardInput()); });
            input.IsBackground = true;
            input.Start();

            Coord current = WindowSize();
            while (WaitForSingleObject(process.hProcess, 50) != 0)
            {
                TryPaste();
                if (outConsole)
                {
                    Coord next = WindowSize();
                    if (next.X != current.X || next.Y != current.Y) { ResizePseudoConsole(console, next); current = next; }
                }
            }
            uint exitCode;
            GetExitCodeProcess(process.hProcess, out exitCode);
            finished = true;
            ClosePseudoConsole(console);
            output.Join(2000);
            input.Join(300);
            if (inConsole) SetConsoleMode(stdin, savedIn);
            if (outConsole) { SetConsoleMode(stdout, savedOut); Console.OutputEncoding = savedOutputEncoding; }
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            return (int)exitCode;
        }

        static void PumpOutput(Stream source, Stream target)
        {
            var buffer = new byte[65536];
            var decoder = Encoding.UTF8.GetDecoder();
            var chars = new char[65537];
            try
            {
                int count;
                while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
                {
                    target.Write(buffer, 0, count);
                    target.Flush();
                    int length = decoder.GetChars(buffer, 0, count, chars, 0);
                    lock (Gate)
                    {
                        lastOutput = Now();
                        if (pasted) continue;
                        string text = tail + new string(chars, 0, length);
                        int on = text.LastIndexOf("\x1b[?2004h", StringComparison.Ordinal);
                        int off = text.LastIndexOf("\x1b[?2004l", StringComparison.Ordinal);
                        if (on != -1 || off != -1) pasteMode = on > off;
                        if (pasteMode && readySince < 0) readySince = lastOutput;
                        tail = text.Length > 16 ? text.Substring(text.Length - 16) : text;
                        screen = screen + Ansi.Replace(new string(chars, 0, length), "");
                        if (screen.Length > 6000) screen = screen.Substring(screen.Length - 6000);
                    }
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        }

        static void UserInput(byte[] data, int count)
        {
            var copy = new byte[count];
            Array.Copy(data, copy, count);
            SendToAgent(copy);
            lock (Gate)
            {
                if (!pasted && (Array.IndexOf(copy, (byte)13) != -1 || Array.IndexOf(copy, (byte)10) != -1))
                {
                    waitingForUser = false;
                    screen = "";
                    lastOutput = Now();
                    readySince = lastOutput;
                }
            }
        }

        static void PumpStreamInput(Stream source)
        {
            var buffer = new byte[4096];
            try
            {
                int count;
                while (!finished && (count = source.Read(buffer, 0, buffer.Length)) > 0) UserInput(buffer, count);
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        }

        static bool ModifierOnly(short virtualKey)
        {
            // Shift, Ctrl, Alt, Caps Lock, Windows keys, Num Lock, Scroll Lock:
            // pressed alone they produce no characters.
            return virtualKey == 0x10 || virtualKey == 0x11 || virtualKey == 0x12 || virtualKey == 0x14
                || virtualKey == 0x5B || virtualKey == 0x5C || virtualKey == 0x90 || virtualKey == 0x91;
        }

        // ENABLE_VIRTUAL_TERMINAL_INPUT makes ReadFile/ReadConsole return the VT
        // sequences for every key (arrows, Home, F-keys; Ctrl+C as 0x03), while
        // ReadConsoleInput returns the raw records ("Console Virtual Terminal
        // Sequences", learn.microsoft.com). So keys are read with ReadConsoleW.
        // ReadConsoleW blocks until it has characters, so records that cannot
        // produce any (key-ups, lone modifiers, focus, mouse and size events)
        // are discarded first; that keeps the loop able to stop when the agent
        // exits without swallowing a later key press.
        static void PumpConsoleInput(IntPtr stdin)
        {
            var peeked = new InputRecord[1];
            var discard = new InputRecord[1];
            var chars = new char[4096];
            try
            {
                while (!finished)
                {
                    if (WaitForSingleObject(stdin, 100) != 0) continue;
                    uint available;
                    if (!GetNumberOfConsoleInputEvents(stdin, out available) || available == 0) continue;
                    uint seen;
                    if (!PeekConsoleInput(stdin, peeked, 1, out seen) || seen == 0) continue;
                    bool keyDown = peeked[0].EventType == 1 && peeked[0].KeyEvent.bKeyDown != 0;
                    if (!keyDown || ModifierOnly(peeked[0].KeyEvent.wVirtualKeyCode))
                    {
                        uint dropped;
                        ReadConsoleInput(stdin, discard, 1, out dropped);
                        continue;
                    }
                    uint read;
                    if (!ReadConsole(stdin, chars, (uint)chars.Length, out read, IntPtr.Zero)) break;
                    if (read == 0) continue;
                    byte[] bytes = Encoding.UTF8.GetBytes(chars, 0, (int)read);
                    UserInput(bytes, bytes.Length);
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        }

        static void TryPaste()
        {
            lock (Gate)
            {
                if (pasted) return;
                long now = Now();
                if (now - started > DeadlineMs) { pasted = true; return; }
                if (!pasteMode || waitingForUser) return;
                if (now - lastOutput < QuietMs && now - readySince < SettleMs) return;
                if (Trust.IsMatch(screen)) { waitingForUser = true; return; }
                pasted = true;
            }
            SendToAgent(paste);
        }
    }
}
`
