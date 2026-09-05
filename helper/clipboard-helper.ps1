#requires -Version 5.1

param([switch]$ValidateOnly)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class FastClipboardBridge
{
    private const string PayloadPrefix = "FAST_ANNOUNCEMENT_QUEUE_V1|";
    private const int WhKeyboardLl = 13;
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyDown = 0x0104;
    private const int WmSysKeyUp = 0x0105;
    private const int VkControl = 0x11;
    private const int VkV = 0x56;
    private const uint LlkhfInjected = 0x10;
    private const uint KeyeventfKeyup = 0x0002;

    private static readonly string[] FieldNames = { "titulo", "mensagem", "duracao", "imagem" };
    private static readonly List<string> Queue = new List<string>();
    private static LowLevelKeyboardProc _hookProc;
    private static IntPtr _hookId = IntPtr.Zero;
    private static ApplicationContext _context;
    private static Control _dispatcher;
    private static System.Windows.Forms.Timer _timer;
    private static Mutex _mutex;
    private static Thread _commandThread;
    private static int _queueIndex;
    private static bool _active;
    private static bool _handledVDown;
    private static bool _stopping;

    [STAThread]
    public static int Run()
    {
        bool createdNew;
        _mutex = new Mutex(true, "Local\\FAST_Announcement_Paste_Helper_V1", out createdNew);
        if (!createdNew) {
            Emit("CONFLICT");
            return 10;
        }

        try {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            _context = new ApplicationContext();
            _dispatcher = new Control();
            _dispatcher.CreateControl();

            _timer = new System.Windows.Forms.Timer { Interval = 75 };
            _timer.Tick += delegate { TryLoadQueueFromClipboard(); };
            _timer.Start();

            _hookProc = HookCallback;
            _hookId = SetWindowsHookEx(WhKeyboardLl, _hookProc, GetModuleHandle(null), 0);
            if (_hookId == IntPtr.Zero) {
                Emit("ERROR", "Nao foi possivel iniciar o monitor de Ctrl+V.");
                return 11;
            }

            _commandThread = new Thread(CommandLoop) { IsBackground = true, Name = "FAST clipboard commands" };
            _commandThread.Start();
            Emit("READY");
            EmitStatus();
            Application.Run(_context);
            return 0;
        }
        catch (Exception ex) {
            Emit("ERROR", Clean(ex.Message));
            return 12;
        }
        finally {
            _stopping = true;
            if (_timer != null) { _timer.Stop(); _timer.Dispose(); }
            if (_hookId != IntPtr.Zero) { UnhookWindowsHookEx(_hookId); _hookId = IntPtr.Zero; }
            if (_dispatcher != null) _dispatcher.Dispose();
            if (_mutex != null) {
                try { _mutex.ReleaseMutex(); } catch { }
                _mutex.Dispose();
            }
        }
    }

    private static void CommandLoop()
    {
        while (!_stopping) {
            string line;
            try { line = Console.ReadLine(); }
            catch { return; }
            if (line == null) return;
            string command = line.Trim().ToLowerInvariant();
            try {
                if (_dispatcher == null || _dispatcher.IsDisposed) return;
                if (command == "cancel") {
                    _dispatcher.BeginInvoke((Action)(() => CancelSequence(true)));
                } else if (command == "stop") {
                    _dispatcher.BeginInvoke((Action)(() => {
                        _stopping = true;
                        if (_context != null) _context.ExitThread();
                    }));
                    return;
                }
            } catch { return; }
        }
    }

    private static bool TryLoadQueueFromClipboard()
    {
        string clipboardText;
        if (!TryReadPayloadFromClipboard(out clipboardText)) return false;
        string[] encodedFields = clipboardText.Substring(PayloadPrefix.Length).Split('|');
        if (encodedFields.Length < 3) return false;

        var decodedFields = new List<string>();
        for (int i = 0; i < encodedFields.Length && i < FieldNames.Length; i++) {
            try {
                string decoded = Encoding.UTF8.GetString(Convert.FromBase64String(encodedFields[i]));
                if (!String.IsNullOrWhiteSpace(decoded)) decodedFields.Add(decoded);
            } catch {
                CancelSequence(false);
                Emit("ERROR", "Sequencia Ctrl+V invalida.");
                return false;
            }
        }
        if (decodedFields.Count < 3) return false;

        Queue.Clear();
        Queue.AddRange(decodedFields);
        _queueIndex = 0;
        _active = true;
        if (!SetClipboardText(Queue[0])) {
            CancelSequence(false);
            Emit("ERROR", "A area de transferencia esta ocupada.");
            return false;
        }
        EmitStatus();
        Emit("EVENT", "sequence-ready", Queue.Count.ToString());
        return true;
    }

    private static bool TryReadPayloadFromClipboard(out string clipboardText)
    {
        clipboardText = null;
        try {
            if (Clipboard.ContainsText(TextDataFormat.Html)) {
                string html = Clipboard.GetText(TextDataFormat.Html);
                int start = html.IndexOf(PayloadPrefix, StringComparison.Ordinal);
                if (start >= 0) {
                    int end = start;
                    while (end < html.Length && !Char.IsWhiteSpace(html[end]) && html[end] != '<' && html[end] != '>') end++;
                    clipboardText = html.Substring(start, end - start);
                }
            }
            if (String.IsNullOrEmpty(clipboardText) && Clipboard.ContainsText(TextDataFormat.UnicodeText)) {
                string plain = Clipboard.GetText(TextDataFormat.UnicodeText);
                if (!String.IsNullOrEmpty(plain) && plain.StartsWith(PayloadPrefix, StringComparison.Ordinal)) clipboardText = plain;
            }
        } catch { return false; }
        return !String.IsNullOrEmpty(clipboardText) && clipboardText.StartsWith(PayloadPrefix, StringComparison.Ordinal);
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0) {
            var data = (KbdLlHookStruct)Marshal.PtrToStructure(lParam, typeof(KbdLlHookStruct));
            bool injected = (data.flags & LlkhfInjected) != 0;
            bool keyDown = wParam == (IntPtr)WmKeyDown || wParam == (IntPtr)WmSysKeyDown;
            bool keyUp = wParam == (IntPtr)WmKeyUp || wParam == (IntPtr)WmSysKeyUp;

            if (!injected && data.vkCode == VkV) {
                if (keyDown && IsControlDown()) {
                    TryLoadQueueFromClipboard();
                    if (_active) {
                        if (!_handledVDown) {
                            _handledVDown = true;
                            PasteNextValue();
                        }
                        return (IntPtr)1;
                    }
                } else if (keyUp && _handledVDown) {
                    _handledVDown = false;
                    return (IntPtr)1;
                }
            }
        }
        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    private static void PasteNextValue()
    {
        if (!_active || _queueIndex < 0 || _queueIndex >= Queue.Count) return;
        if (!SetClipboardText(Queue[_queueIndex])) {
            CancelSequence(false);
            Emit("ERROR", "A area de transferencia esta ocupada. Prepare a sequencia novamente.");
            return;
        }

        SendPasteShortcut();
        _queueIndex++;
        if (_queueIndex >= Queue.Count) {
            int completedCount = Queue.Count;
            Queue.Clear();
            _queueIndex = 0;
            _active = false;
            EmitStatus();
            Emit("EVENT", "sequence-complete", completedCount.ToString());
        } else {
            EmitStatus();
        }
    }

    private static bool SetClipboardText(string value)
    {
        for (int attempt = 0; attempt < 5; attempt++) {
            try {
                Clipboard.SetText(value ?? String.Empty, TextDataFormat.UnicodeText);
                return true;
            } catch { Thread.Sleep(25); }
        }
        return false;
    }

    private static void SendPasteShortcut()
    {
        keybd_event((byte)VkControl, 0, 0, UIntPtr.Zero);
        keybd_event((byte)VkV, 0, 0, UIntPtr.Zero);
        keybd_event((byte)VkV, 0, KeyeventfKeyup, UIntPtr.Zero);
        keybd_event((byte)VkControl, 0, KeyeventfKeyup, UIntPtr.Zero);
    }

    private static bool IsControlDown()
    {
        return (GetAsyncKeyState(VkControl) & 0x8000) != 0;
    }

    private static void CancelSequence(bool notify)
    {
        bool wasActive = _active;
        Queue.Clear();
        _queueIndex = 0;
        _active = false;
        _handledVDown = false;
        EmitStatus();
        if (notify && wasActive) Emit("EVENT", "sequence-cancelled", "0");
    }

    private static void EmitStatus()
    {
        string field = "";
        if (_active && Queue.Count > 0) {
            int index = Math.Min(_queueIndex, Queue.Count - 1);
            field = index < FieldNames.Length ? FieldNames[index] : "proximo campo";
        }
        Emit("STATUS", _active ? "1" : "0", _queueIndex.ToString(), Queue.Count.ToString(), field);
    }

    private static string Clean(string value)
    {
        return (value ?? "").Replace("|", "/").Replace("\r", " ").Replace("\n", " ");
    }

    private static void Emit(params string[] parts)
    {
        try {
            Console.WriteLine("FAST_HELPER|" + String.Join("|", parts));
            Console.Out.Flush();
        } catch { }
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KbdLlHookStruct
    {
        public int vkCode;
        public int scanCode;
        public uint flags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
'@

try {
    Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.Windows.Forms') -ErrorAction Stop
    if ($ValidateOnly) { exit 0 }
    exit [FastClipboardBridge]::Run()
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 12
}
