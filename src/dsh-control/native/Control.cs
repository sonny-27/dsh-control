using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace DshControl {
public class Failure : Exception {
    public string Code;
    public Failure(string code, string message) : base(message) { Code = code; }
}
public class Badge : Form {
    public Button Stop; public string Phase="observe", Message="正在查看屏幕"; public int Frame; public bool TakeoverAvailable;
    public Color Accent { get { return Phase=="mouse"?Color.FromArgb(91,142,255):Phase=="review"||Phase=="approval"||Phase=="blocked"?Color.FromArgb(255,187,70):Phase=="uia"?Color.FromArgb(180,142,255):Color.FromArgb(60,210,206); } }
    public Badge() {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
        BackColor = Color.FromArgb(20,26,39); Size = new Size(520, 72); DoubleBuffered=true;Opacity=0.99;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(Screen.PrimaryScreen.WorkingArea.Right - Width - 20, Screen.PrimaryScreen.WorkingArea.Top + 16);
        Stop=new Button {Text="停止",AccessibleName="停止 AI 电脑操控",FlatStyle=FlatStyle.Flat,ForeColor=Color.White,BackColor=Color.FromArgb(47,59,78),Font=new Font("Microsoft YaHei UI",10),Bounds=new Rectangle(430,20,70,32),TabStop=false};
        Stop.FlatAppearance.BorderColor=Color.FromArgb(95,115,140);Controls.Add(Stop);
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e); var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;
        float pulse=(float)(0.55+0.45*Math.Sin(Frame*0.12));
        using(var p=new Pen(Color.FromArgb((int)(110+100*pulse),Accent),2))g.DrawRectangle(p,1,1,Width-3,Height-3);
        using(var p=new Pen(Color.FromArgb(55,Accent),4))g.DrawEllipse(p,19,23,25,25);
        using(var p=new Pen(Accent,4)){p.StartCap=LineCap.Round;p.EndCap=LineCap.Round;g.DrawArc(p,19,23,25,25,Frame*9%360,240);}
        using(var font=new Font("Microsoft YaHei UI",11,FontStyle.Bold))using(var brush=new SolidBrush(Color.White))g.DrawString("DSH · "+Message,font,brush,60,12);
        string hint=Phase=="approval"?"尚未投递输入 · 请批准或拒绝":(Phase=="mouse"?"系统鼠标使用中":"系统鼠标可用")+(TakeoverAvailable?" · 人工输入立即接管":" · 可点击停止接管");
        using(var font=new Font("Microsoft YaHei UI",8.5f))using(var brush=new SolidBrush(Color.FromArgb(179,193,216)))g.DrawString(hint+" · Esc 停止",font,brush,60,42);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00000020 | 0x00000080; return p; } }
    protected override void WndProc(ref Message m) { if (m.Msg == 0x84) { int x=(short)(m.LParam.ToInt64()&65535),y=(short)((m.LParam.ToInt64()>>16)&65535);var p=PointToClient(new Point(x,y));if(!Stop.Bounds.Contains(p)){m.Result = new IntPtr(-1); return;} } base.WndProc(ref m); }
}
// Keep the interactive stop surface separate from the click-through HUD.
public class StopPanel : Form {
    public Button Stop;
    public StopPanel(){FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;StartPosition=FormStartPosition.Manual;Stop=new Button{Text="停止",AccessibleName="停止 AI 电脑操控",Dock=DockStyle.Fill,FlatStyle=FlatStyle.Flat,ForeColor=Color.White,BackColor=Color.FromArgb(47,59,78),Font=new Font("Microsoft YaHei UI",10),TabStop=false};Stop.FlatAppearance.BorderColor=Color.FromArgb(95,115,140);Controls.Add(Stop);}
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x00000080;return p;}}
}
public class ConsentPanel : Form {
    public Label Summary;public Button Once,Same,Reject;
    public ConsentPanel(){FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;StartPosition=FormStartPosition.Manual;BackColor=Color.FromArgb(20,26,39);Size=new Size(720,108);
        Summary=new Label{ForeColor=Color.White,Font=new Font("Microsoft YaHei UI",10),Bounds=new Rectangle(16,12,688,38),AutoEllipsis=true};Controls.Add(Summary);
        Once=Make("允许一次",16,120);Same=Make("同意本会话相同请求",148,220);Reject=Make("拒绝",380,100);Controls.AddRange(new Control[]{Once,Same,Reject});}
    Button Make(string text,int x,int width){return new Button{Text=text,AccessibleName=text,Bounds=new Rectangle(x,60,width,32),ForeColor=Color.White,BackColor=Color.FromArgb(47,59,78),FlatStyle=FlatStyle.Flat,Font=new Font("Microsoft YaHei UI",10)};}
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x00000080;return p;}}
}
public class VisualLayer : Form {
    public bool Halo; public Color Accent; public int Frame; public DateTime RippleUntil;
    public VisualLayer(bool halo) { Halo=halo;FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;BackColor=Color.Magenta;TransparencyKey=BackColor;DoubleBuffered=true;StartPosition=FormStartPosition.Manual; }
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x00000020|0x00000080;return p;}}
    protected override void WndProc(ref Message m){if(m.Msg==0x84){m.Result=new IntPtr(-1);return;}base.WndProc(ref m);}
    protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;
        if(Halo){float t=(float)(0.5+0.5*Math.Sin(Frame*0.14));using(var p=new Pen(Accent,2))g.DrawEllipse(p,18-t*3,18-t*3,34+t*6,34+t*6);
            if(DateTime.UtcNow<RippleUntil){float r=(float)(1-(RippleUntil-DateTime.UtcNow).TotalMilliseconds/650);using(var p=new Pen(Color.FromArgb((int)(255*(1-r)),Accent),3))g.DrawEllipse(p,35-30*r,35-30*r,60*r,60*r);}
        }else{using(var brush=new SolidBrush(Accent))g.FillRectangle(brush,ClientRectangle);}
    }
}
public class Stamp {
    public long Hwnd; public int Pid; public long Start; public RECT Rect;
    public long Revision=-1;
    public volatile bool Invalid;
    public Dictionary<string,Dictionary<int,object>> PropertySnapshots=new Dictionary<string,Dictionary<int,object>>();
    public bool Screen; public long Foreground;
    public Dictionary<long, Stamp> Targets = new Dictionary<long, Stamp>();
    public Dictionary<string, AutomationElement> Elements = new Dictionary<string, AutomationElement>();
    public Dictionary<string, string> Fingerprints = new Dictionary<string, string>();
    public Dictionary<string, RECT> ElementRects = new Dictionary<string, RECT>();
}
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr extra; }
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
[StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint size, tick; }
[StructLayout(LayoutKind.Sequential)] public struct MSHOOK {public POINT point;public uint data,flags,time;public UIntPtr extra;}
[StructLayout(LayoutKind.Sequential)] public struct KBHOOK {public uint vk,scan,flags,time;public UIntPtr extra;}
public static partial class Host {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int count);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendTextTimeout(IntPtr h, uint message, IntPtr w, string text, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    delegate IntPtr HookProc(int code,IntPtr message,IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int kind,HookProc callback,IntPtr module,uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h,uint affinity);
    [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h,out uint affinity);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024, RecursionLimit = 64 };
    static object OutputLock = new object();
    static Badge badge; static Thread ui; static System.Windows.Forms.Timer timer;
    static VisualLayer halo;static StopPanel stopPanel;static ConsentPanel consentPanel;static string consentId="",consentOwner="";static List<VisualLayer> edges=new List<VisualLayer>();
    static HookProc mouseProc,keyboardProc;static IntPtr mouseHook,keyboardHook;
    static volatile string visualOwner="";static volatile bool watchHuman,continuous;
    static bool consumeStopUp;static int takeoverSent;static bool captureExcluded;
    static volatile bool captureSuspended;
    static long visualGeneration;
    static ManualResetEvent ready = new ManualResetEvent(false);
    static volatile bool cancelled, stopping; static DateTime badgeUntil; static bool escWasDown;
    static Mutex lease = new Mutex(false, "Local\\DSH-Control-Input-" + Process.GetCurrentProcess().SessionId);
    static bool leased;
    static object InputLock=new object();
    static Dictionary<uint,INPUT> heldInputs=new Dictionary<uint,INPUT>();
    static ConcurrentDictionary<string, Stamp> observations = new ConcurrentDictionary<string, Stamp>();
    static Queue<string> observationOrder = new Queue<string>();
    public static Dictionary<string, object> Obj(params object[] pairs) { var r = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) r[(string)pairs[i]] = pairs[i + 1]; return r; }
    static string Str(Dictionary<string, object> a, string key, string fallback = "") { return a.ContainsKey(key) ? Convert.ToString(a[key]) : fallback; }
    static int Num(Dictionary<string, object> a, string key, int fallback = 0) { return a.ContainsKey(key) ? Convert.ToInt32(a[key]) : fallback; }
    static void Write(object value) { lock(OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
    static void Check() { if (cancelled || (GetAsyncKeyState(0x1b) & 0x8000) != 0) throw new Failure("CANCELLED", "Esc 已中止操作；不可自动重放未确认动作"); }
    static void RequireLease() { Check(); if (!leased) throw new Failure("LEASE_REQUIRED", "必须先取得输入控制权"); }
    static string Title(IntPtr h) { var b = new StringBuilder(2048); GetWindowText(h, b, b.Capacity); return b.ToString(); }
    static string ClassName(IntPtr h) { var b=new StringBuilder(256); GetClassName(h,b,b.Capacity); return b.ToString(); }
    static bool Shell(Stamp s) { string c=ClassName(new IntPtr(s.Hwnd)); return c=="Progman"||c=="WorkerW"||c=="Shell_TrayWnd"||c=="Shell_SecondaryTrayWnd"; }
    static RECT ScreenRect() { int x=GetSystemMetrics(76),y=GetSystemMetrics(77); return new RECT {Left=x,Top=y,Right=x+GetSystemMetrics(78),Bottom=y+GetSystemMetrics(79)}; }
    static bool SameRect(RECT a,RECT b) { return a.Left==b.Left&&a.Top==b.Top&&a.Right==b.Right&&a.Bottom==b.Bottom; }
    static Stamp Identity(long handle) {
        IntPtr h = new IntPtr(handle); uint pid; RECT rect;
        if (!IsWindow(h) || !GetWindowRect(h, out rect)) throw new Failure("WINDOW_GONE", "目标窗口已关闭");
        GetWindowThreadProcessId(h, out pid);
        var process = Process.GetProcessById((int)pid);
        return new Stamp { Hwnd = handle, Pid = (int)pid, Start = process.StartTime.ToUniversalTime().Ticks, Rect = rect };
    }
    static void Verify(Stamp s) {
        Check();
        if(s.Screen) { if(!SameRect(s.Rect,ScreenRect())) throw new Failure("SCREEN_CHANGED","显示器布局已改变，请重新 screen"); return; }
        var n = Identity(s.Hwnd);
        if (n.Pid != s.Pid || n.Start != s.Start) throw new Failure("IDENTITY_CHANGED", "目标窗口进程发生变化");
        if (n.Rect.Left != s.Rect.Left || n.Rect.Top != s.Rect.Top || n.Rect.Right != s.Rect.Right || n.Rect.Bottom != s.Rect.Bottom) throw new Failure("WINDOW_MOVED", "窗口位置或大小已变化，请重新观察");
    }
    static bool OwnsForeground(Stamp s) { return GetAncestor(GetForegroundWindow(),2)==new IntPtr(s.Hwnd); }
    static void Restore(Stamp s) {
        Verify(s); Busy(); var h=new IntPtr(s.Hwnd);
        if(IsIconic(h)) {
            ShowWindow(h,9);
            var deadline=DateTime.UtcNow.AddSeconds(2);
            while(IsIconic(h)&&DateTime.UtcNow<deadline) {Check();Thread.Sleep(40);}
            if(IsIconic(h)) throw new Failure("RESTORE_DENIED","Windows 未还原窗口，请重新观察状态，不可重复点击");
            var n=Identity(s.Hwnd);
            if(n.Pid!=s.Pid||n.Start!=s.Start) throw new Failure("IDENTITY_CHANGED","还原期间窗口身份改变");
            s.Rect=n.Rect;
        }
    }
    static void Foreground(Stamp s) {
        Verify(s); IntPtr h = new IntPtr(s.Hwnd);
        if (IsIconic(h)) throw new Failure("WINDOW_MINIMIZED", "请先还原窗口并重新观察");
        if (!OwnsForeground(s)) { RequestForeground(h); Thread.Sleep(100); }
        if (!OwnsForeground(s)) {
            // Explicit mouse permission also allows one visible title-bar click.
            // Never type or click content until the exact foreground is confirmed.
            Verify(s); Busy(); IntPtr previous=GetForegroundWindow();
            SetWindowPos(h,IntPtr.Zero,0,0,0,0,0x1|0x2|0x10);
            int x=s.Rect.Left+Math.Min(80,(s.Rect.Right-s.Rect.Left)/2), y=s.Rect.Top+14;
            if(GetAncestor(WindowFromPoint(new POINT {X=x,Y=y}),2)!=h) throw new Failure("TARGET_OCCLUDED","目标标题栏被遮挡，无法激活");
            UIntPtr hit; long point=((long)(ushort)y<<16)|(ushort)x;
            if(SendMessageTimeout(h,0x84,IntPtr.Zero,new IntPtr(point),0x2,500,out hit)==IntPtr.Zero || hit.ToUInt64()!=2) throw new Failure("FOCUS_DENIED","目标没有可验证的标题栏，请手动切换窗口");
            Verify(s); Busy(); if(GetForegroundWindow()!=previous) throw new Failure("HUMAN_INPUT_BUSY","用户正在切换窗口，停止激活");
            Input(new INPUT[] {Absolute(x,y),Mouse(2),Mouse(4)}); Thread.Sleep(150);
            if(!OwnsForeground(s)) throw new Failure("PARTIAL_DELIVERY","标题栏激活未确认，不可自动重放");
        }
        if (!OwnsForeground(s)) throw new Failure("FOCUS_DENIED", "Windows 拒绝激活目标窗口，请手动切换后重试");
        Verify(s);
    }
    static void RequestForeground(IntPtr h) {
        if(SetForegroundWindow(h)) return;
        uint pid; uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out pid), current=GetCurrentThreadId();
        bool attached=false;
        try { if(foregroundThread!=0&&foregroundThread!=current) attached=AttachThreadInput(current,foregroundThread,true); SetForegroundWindow(h); }
        finally { if(attached) AttachThreadInput(current,foregroundThread,false); }
    }
    static uint LastInput() { var info=new LASTINPUTINFO { size=(uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) }; GetLastInputInfo(ref info); return info.tick; }
    static bool NativeClass(AutomationElement e,string expected) { var h=new IntPtr(e.Current.NativeWindowHandle); if(h==IntPtr.Zero)return false; var name=new StringBuilder(256); GetClassName(h,name,name.Capacity); return name.ToString().Equals(expected,StringComparison.OrdinalIgnoreCase)||name.ToString().StartsWith("WindowsForms10."+expected+".",StringComparison.OrdinalIgnoreCase); }
    static void Track(INPUT value) {
        if(value.type==1) { var k=value.u.key; uint id=(k.flags&4)!=0?0x10000u+k.scan:k.vk; if((k.flags&2)!=0) heldInputs.Remove(id); else heldInputs[id]=Key(k.vk,true,k.scan,(k.flags&4)!=0); }
        else { uint f=value.u.mouse.dwFlags; foreach(var pair in new uint[][] {new uint[] {2,4,1},new uint[] {8,16,2},new uint[] {32,64,3}}) { uint id=0x20000+pair[2]; if((f&pair[0])!=0) heldInputs[id]=Mouse(pair[1]); if((f&pair[1])!=0) heldInputs.Remove(id); } }
    }
    static void Deliver(INPUT[] values) { uint sent=SendInput((uint)values.Length,values,Marshal.SizeOf(typeof(INPUT))); for(int i=0;i<sent;i++) Track(values[i]); if(sent!=values.Length) throw new Failure("PARTIAL_DELIVERY","SendInput 未完整投递；可能受 UIPI 或权限限制，不可自动重放"); }
    static void Input(INPUT[] values) { lock(InputLock) { Check(); Deliver(values);foreach(var v in values)if(v.type==0&&(v.u.mouse.dwFlags&(2|8|32))!=0&&halo!=null&&!halo.IsDisposed)halo.BeginInvoke(new Action(delegate {halo.RippleUntil=DateTime.UtcNow.AddMilliseconds(650);})); } }
    static void Release(INPUT[] values) { lock(InputLock) { Deliver(values); } }
    static void ReleaseOwned() { lock(InputLock) { if(heldInputs.Count>0) { var values=new List<INPUT>(heldInputs.Values).ToArray(); SendInput((uint)values.Length,values,Marshal.SizeOf(typeof(INPUT))); heldInputs.Clear(); } } }
    static void Cancel() { lock(InputLock) { cancelled=true; ReleaseOwned(); } if(badge!=null&&!badge.IsDisposed) badge.BeginInvoke(new Action(delegate {HideVisuals();})); }
    static INPUT Mouse(uint flags, int x = 0, int y = 0, uint data = 0) { return new INPUT { type = 0, u = new INPUTUNION { mouse = new MOUSEINPUT { dx = x, dy = y, mouseData = data, dwFlags = flags } } }; }
    static INPUT Key(ushort vk, bool up, ushort scan = 0, bool unicode = false) { return new INPUT { type = 1, u = new INPUTUNION { key = new KEYBDINPUT { vk = vk, scan = scan, flags = (up ? 2u : 0u) | (unicode ? 4u : 0u) } } }; }
    static void Busy() { foreach(int k in new int[] {1, 2, 4, 16, 17, 18}) if ((GetAsyncKeyState(k) & 0x8000) != 0) throw new Failure("HUMAN_INPUT_BUSY", "用户正在使用鼠标或修饰键，请稍后重新观察"); }
    static INPUT Absolute(int x,int y) { int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79); return Mouse(0x8000|0x4000|1,(int)Math.Round((x-left)*65535.0/Math.Max(1,width-1)),(int)Math.Round((y-top)*65535.0/Math.Max(1,height-1))); }
    static INPUT Move(Stamp s, int x, int y) {
        Verify(s);
        if (x < s.Rect.Left || x >= s.Rect.Right || y < s.Rect.Top || y >= s.Rect.Bottom) throw new Failure("OUT_OF_WINDOW", "坐标超出目标窗口");
        if (!Shell(s) && !OwnsForeground(s)) throw new Failure("FOCUS_CHANGED", "用户已切换窗口，停止输入");
        if (GetAncestor(WindowFromPoint(new POINT { X = x, Y = y }), 2).ToInt64() != s.Hwnd) throw new Failure("TARGET_OCCLUDED", "点击位置被其他窗口遮挡");
        return Absolute(x,y);
    }
    static void VerifyElementHit(Stamp s, Dictionary<string, object> a, int x, int y) {
        if(!a.ContainsKey("elementId")) return;
        var target=new IntPtr(Element(a,s).Current.NativeWindowHandle);
        if(target==IntPtr.Zero || target==new IntPtr(s.Hwnd)) return;
        var hit=WindowFromPoint(new POINT {X=x,Y=y});
        if(hit!=target && !IsChild(target,hit)) throw new Failure("TARGET_OCCLUDED","目标控件被同一窗口中的其他控件遮挡，请重新观察或使用后台模式");
    }
    static object RectObject(RECT r) { return Obj("x", r.Left, "y", r.Top, "width", r.Right - r.Left, "height", r.Bottom - r.Top); }
    static bool IsVisual(IntPtr h) { if(h==badge.Handle||h==halo.Handle||h==stopPanel.Handle||h==consentPanel.Handle)return true;foreach(var edge in edges)if(h==edge.Handle)return true;return false; }
    static void HideVisuals() {consentPanel.Hide();stopPanel.Hide();badge.Hide();halo.Hide();foreach(var edge in edges)edge.Hide();watchHuman=false;continuous=false;visualOwner="";}
    static void SetVisual(string owner,string phase,bool human,bool keep) {
        bool first=!badge.Visible||visualOwner!=owner;
        visualOwner=owner;watchHuman=human;continuous=keep;Interlocked.Exchange(ref takeoverSent,0);
        badge.Phase=phase;badge.Message=phase=="mouse"?"正在使用鼠标":phase=="uia"?"后台无障碍操作":phase=="review"?"正在审查操作":phase=="approval"?"等待人工审批":phase=="blocked"?"操作被阻止 · 等待下一步":phase=="thinking"?"正在分析 · 操控待续":phase=="browser"?"正在操作浏览器":"正在查看屏幕";
        if(first){IntPtr foreground=GetForegroundWindow();var display=foreground==IntPtr.Zero?Screen.FromPoint(Cursor.Position):Screen.FromHandle(foreground);var area=display.WorkingArea;badge.Location=new Point(area.Left+Math.Max(0,(area.Width-badge.Width)/2),area.Top+16);}
        badgeUntil=DateTime.MaxValue;badge.Show();ShowWindow(badge.Handle,4);
        stopPanel.Bounds=badge.RectangleToScreen(badge.Stop.Bounds);stopPanel.Show();ShowWindow(stopPanel.Handle,4);
        if(!SetWindowPos(badge.Handle,new IntPtr(-1),0,0,0,0,0x1|0x2|0x10|0x40)||!SetWindowPos(stopPanel.Handle,new IntPtr(-1),0,0,0,0,0x1|0x2|0x10|0x40))throw new Failure("INDICATOR_UNAVAILABLE","Windows 无法显示置顶提示，停止电脑干预");
        foreach(var edge in edges){edge.Accent=badge.Accent;edge.Show();ShowWindow(edge.Handle,4);}
        if(phase=="mouse") {POINT point;GetCursorPos(out point);halo.Location=new Point(point.X-35,point.Y-35);halo.Accent=badge.Accent;halo.Show();ShowWindow(halo.Handle,4);} else halo.Hide();
        badge.Invalidate();badge.Update();stopPanel.Update();DwmFlush();
    }
    public static bool HumanInput(bool keyboard,uint flags,int message) {
        return keyboard?(flags&0x10)==0&&(message==0x100||message==0x104):(flags&1)==0&&(message==0x201||message==0x204||message==0x207||message==0x20B||message==0x20A||message==0x20E);
    }
    static void Takeover(string reason) {
        if((!badge.Visible&&!captureSuspended)||Interlocked.Exchange(ref takeoverSent,1)!=0)return;
        string owner=visualOwner;cancelled=true;HideVisuals();
        ThreadPool.QueueUserWorkItem(delegate {ReleaseOwned();});
        Write(Obj("event",reason=="escape"?"escape":"takeover","owner",owner,"reason",reason));
    }
    static IntPtr MouseHook(int code,IntPtr message,IntPtr data) {
        if(code>=0){var e=(MSHOOK)Marshal.PtrToStructure(data,typeof(MSHOOK));int msg=message.ToInt32();
            if(browserWatchHuman&&HumanInput(false,e.flags,msg)&&BrowserWindow(WindowFromPoint(e.point)))BrowserTakeover("browser-human-mouse");
            if(consumeStopUp&&msg==0x202&&(e.flags&1)==0){consumeStopUp=false;return new IntPtr(1);}
            if((badge.Visible||captureSuspended)&&HumanInput(false,e.flags,msg)){
                var stop=badge.RectangleToScreen(badge.Stop.Bounds);bool ownStop=msg==0x201&&stop.Contains(e.point.X,e.point.Y);
                if(ownStop||watchHuman){Takeover(ownStop?"stop-button":"human-mouse");if(ownStop){consumeStopUp=true;return new IntPtr(1);}}
            }
        }return CallNextHookEx(mouseHook,code,message,data);
    }
    static IntPtr KeyboardHook(int code,IntPtr message,IntPtr data) {
        if(code>=0){var key=(KBHOOK)Marshal.PtrToStructure(data,typeof(KBHOOK));if(HumanInput(true,key.flags,message.ToInt32())&&(browserWatchHuman||key.vk==27)&&BrowserWindow(GetForegroundWindow()))BrowserTakeover(key.vk==27?"browser-escape":"browser-human-keyboard");}
        if(code>=0&&(badge.Visible||captureSuspended)){var e=(KBHOOK)Marshal.PtrToStructure(data,typeof(KBHOOK));if(HumanInput(true,e.flags,message.ToInt32())&&(watchHuman||e.vk==27))Takeover(e.vk==27?"escape":"human-keyboard");}
        return CallNextHookEx(keyboardHook,code,message,data);
    }
    static object Windows(Stamp screen = null) {
        var result = new List<object>();
        EnumWindows(delegate(IntPtr h, IntPtr d) {
            try {
                string title = Title(h); if (!IsWindowVisible(h) || IsVisual(h)) return true;
                var s = Identity(h.ToInt64()); string path = null;
                string className=ClassName(h);
                if(screen!=null) screen.Targets[s.Hwnd]=s;
                try { path = Process.GetProcessById(s.Pid).MainModule.FileName; } catch { }
                result.Add(Obj("windowId", s.Hwnd, "processId", s.Pid, "title", title, "className", className, "kind", className=="Shell_TrayWnd"||className=="Shell_SecondaryTrayWnd"?"taskbar":className=="Progman"||className=="WorkerW"?"desktop":"application", "executable", path, "rect", RectObject(s.Rect), "minimized", IsIconic(h), "foreground", OwnsForeground(s)));
            } catch { }
            return true;
        }, IntPtr.Zero);
        return Obj("windows", result);
    }
    static string Store(Stamp s) {
        string token=Guid.NewGuid().ToString(); observations[token]=s; observationOrder.Enqueue(token);
        while(observationOrder.Count>128){Stamp removed;observations.TryRemove(observationOrder.Dequeue(),out removed);} return token;
    }
    static object ScreenObservation() {
        var s=new Stamp {Screen=true,Rect=ScreenRect(),Foreground=GetAncestor(GetForegroundWindow(),2).ToInt64()};
        var windows=(Dictionary<string,object>)Windows(s); Verify(s);
        return Obj("scope","screen","nativeObservation",Store(s),"rect",RectObject(s.Rect),"windows",windows["windows"],"foregroundWindowId",s.Foreground,"elements",new object[0],"hint","点击时传此 windows 列表中的实际目标 windowId、mode:mouse、绝对 x/y；桌面和任务栏不要求聚焦。后台 UIA 控件请 observe 具体窗口。");
    }
    static object Observe(Dictionary<string, object> a) {
        var s = Identity(Convert.ToInt64(a["windowId"]));
        var watch=WatchWindow(s);s.Revision=watch.Available?Interlocked.Read(ref watch.Version):-1;
        var elements = new List<object>(); var warnings=new List<string>();
        var queue = new Queue<KeyValuePair<AutomationElement, int>>();
        bool useCache=Str(a,"useCache","True").ToLower()!="false";var cache=TreeCache();int cacheBatches=0,cachedNodes=0,directNodes=0;var clock=Stopwatch.StartNew();
        try { var root=AutomationElement.FromHandle(new IntPtr(s.Hwnd));if(useCache){root=root.GetUpdatedCache(cache);cacheBatches++;}queue.Enqueue(new KeyValuePair<AutomationElement, int>(root,0)); }
        catch(Exception e) { warnings.Add("UIA root unavailable: "+e.GetType().Name); }
        var deadline=DateTime.UtcNow.AddMilliseconds(Math.Max(300,Math.Min(3000,Num(a,"budgetMs",3000))));
        int max = Math.Max(1, Math.Min(1000, Num(a, "maxElements", 300))), visits = 0;string queryFilter=Str(a,"queryFilter");
        while(queue.Count > 0 && visits++ < max * 3 && elements.Count < max && DateTime.UtcNow<deadline) {
            Check();
            var entry = queue.Dequeue(); var e = entry.Key;
            try {
                AutomationElement.AutomationElementInformation c;bool cached=useCache;
                try{c=cached?e.Cached:e.Current;}catch(InvalidOperationException){cached=false;c=e.Current;}
                if(cached)cachedNodes++;else directNodes++;
                string id = "e" + elements.Count;
                // Locate needs named matches, not patterns/text for every unrelated node.
                // Still traverse containers; input later verifies fresh current identity.
                if(queryFilter.Length==0||c.Name.IndexOf(queryFilter,StringComparison.OrdinalIgnoreCase)>=0){
                object pattern; var capabilities = new List<string>();
                if(cached?e.TryGetCachedPattern(InvokePattern.Pattern,out pattern):e.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) capabilities.Add("invoke");
                if(cached?e.TryGetCachedPattern(TogglePattern.Pattern,out pattern):e.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) capabilities.Add("toggle");
                if(cached?e.TryGetCachedPattern(SelectionItemPattern.Pattern,out pattern):e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) capabilities.Add("select");
                if(cached?e.TryGetCachedPattern(ScrollPattern.Pattern,out pattern):e.TryGetCurrentPattern(ScrollPattern.Pattern,out pattern))capabilities.Add("scroll");
                if((cached?e.TryGetCachedPattern(ValuePattern.Pattern,out pattern):e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) && !(cached?((ValuePattern)pattern).Cached.IsReadOnly:((ValuePattern)pattern).Current.IsReadOnly)) capabilities.Add("value");
                var r = c.BoundingRectangle;
                string text = null;
                if(!c.IsPassword) {
                    if(cached?e.TryGetCachedPattern(ValuePattern.Pattern,out pattern):e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) text = cached?((ValuePattern)pattern).Cached.Value:((ValuePattern)pattern).Current.Value;
                    else if((c.ControlType==ControlType.Document || c.ControlType==ControlType.Edit) && (cached?e.TryGetCachedPattern(TextPattern.Pattern,out pattern):e.TryGetCurrentPattern(TextPattern.Pattern, out pattern))) text = ((TextPattern)pattern).DocumentRange.GetText(12000);
                    if(text!=null && text.Length>12000) text=text.Substring(0,12000);
                }
                var item = Obj("elementId", id, "name", c.IsPassword ? "[password]" : c.Name, "value", text, "automationId", c.AutomationId,"identity",String.Join(",",e.GetRuntimeId())+"|"+c.ControlType.Id,"nativeClass",c.ClassName, "role", c.ControlType.ProgrammaticName, "enabled", c.IsEnabled,"focused",c.HasKeyboardFocus, "offscreen", c.IsOffscreen, "password", c.IsPassword, "patterns", capabilities, "rect", Obj("x", r.IsEmpty ? 0 : r.X, "y", r.IsEmpty ? 0 : r.Y, "width", r.IsEmpty ? 0 : r.Width, "height", r.IsEmpty ? 0 : r.Height));
                elements.Add(item); s.Elements[id] = e; s.Fingerprints[id]=String.Join(",",e.GetRuntimeId())+"|"+c.ControlType.Id+"|"+c.Name;
                s.PropertySnapshots[String.Join(",",e.GetRuntimeId())]=SnapshotProperties(e,c,cached,text);
                if(!r.IsEmpty)s.ElementRects[id]=new RECT {Left=(int)Math.Round(r.Left),Top=(int)Math.Round(r.Top),Right=(int)Math.Round(r.Right),Bottom=(int)Math.Round(r.Bottom)};
                }
                if(entry.Value < 24) {
                    if(useCache){AutomationElementCollection children;try{children=e.CachedChildren;}catch(InvalidOperationException){var childrenCache=cache.Clone();childrenCache.TreeScope=TreeScope.Children;children=e.GetUpdatedCache(childrenCache).CachedChildren;cacheBatches++;}if(children!=null)foreach(AutomationElement child in children){if(queue.Count>=max*3)break;queue.Enqueue(new KeyValuePair<AutomationElement,int>(child,entry.Value+1));}}
                    else {var child = TreeWalker.ControlViewWalker.GetFirstChild(e); int siblings = 0;while(child != null && siblings++ < max && queue.Count < max * 3) { queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, entry.Value + 1)); child = TreeWalker.ControlViewWalker.GetNextSibling(child); }}
                }
            } catch(Exception error) { if(error is Failure) throw; if(warnings.Count<8) warnings.Add("UIA node unavailable: "+error.GetType().Name); }
        }
        Verify(s);bool captureChanged=watch.Available&&s.Revision!=Interlocked.Read(ref watch.Version);
        if(captureChanged&&!a.ContainsKey("captureRetry")){a["captureRetry"]=true;Thread.Sleep(40);return Observe(a);}s.Invalid=captureChanged;
        return Obj("scope","window","nativeObservation", Store(s), "windowId", s.Hwnd, "processId", s.Pid,"processStart",s.Start.ToString(), "uiVersion",s.Revision,"uiSourcePid",Process.GetCurrentProcess().Id,"changeMonitoring",watch.Available,"captureChanged",captureChanged,"cache",Obj("enabled",useCache,"batches",cacheBatches,"cachedNodes",cachedNodes,"directNodes",directNodes,"elapsedMs",clock.ElapsedMilliseconds),"title", Title(new IntPtr(s.Hwnd)), "className",ClassName(new IntPtr(s.Hwnd)),"minimized",IsIconic(new IntPtr(s.Hwnd)),"foreground",OwnsForeground(s), "rect", RectObject(s.Rect), "elements", elements, "truncated", queue.Count > 0,"uiaWarnings",warnings,"hint",elements.Count==0?"无障碍控件不可用，仍可 screen 后用真实鼠标坐标操作；不要重复相同 UIA 观察":"界面变化会使观察失效；点击仍核验当前身份与几何，不使用缓存直接投递输入");
    }
    static object Locate(Dictionary<string,object> a) {
        string query=Str(a,"query").Trim();if(query.Length==0)throw new Failure("QUERY_REQUIRED","请输入控件名称 query");
        var inventory=(Dictionary<string,object>)Windows();var groups=new List<object>();var matching=new List<object>();int roots=0;
        foreach(Dictionary<string,object> window in (List<object>)inventory["windows"]){
            long hwnd=Convert.ToInt64(window["windowId"]);string kind=Convert.ToString(window["kind"]),title=Convert.ToString(window["title"]);
            if(title.IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0)matching.Add(window);
            bool explicitWindow=a.ContainsKey("windowId");
            if(explicitWindow?hwnd!=Convert.ToInt64(a["windowId"]):kind!="desktop"&&kind!="taskbar")continue;
            if(Convert.ToBoolean(window["minimized"])||roots++>=6)continue;
            var observed=(Dictionary<string,object>)Observe(Obj("windowId",hwnd,"maxElements",400,"budgetMs",900,"queryFilter",query));var matches=new List<object>();
            foreach(Dictionary<string,object> item in (List<object>)observed["elements"]){
                string name=Convert.ToString(item["name"]),role=Convert.ToString(item["role"]);if(name.IndexOf(query,StringComparison.OrdinalIgnoreCase)<0||!Convert.ToBoolean(item["enabled"])||Convert.ToBoolean(item["offscreen"]))continue;
                if(role!="ControlType.ListItem"&&role!="ControlType.Button"&&role!="ControlType.MenuItem"&&role!="ControlType.Hyperlink"&&role!="ControlType.TabItem")continue;
                var rect=(Dictionary<string,object>)item["rect"];if(Convert.ToDouble(rect["width"])<=0||Convert.ToDouble(rect["height"])<=0)continue;
                int cx=(int)(Convert.ToDouble(rect["x"])+Convert.ToDouble(rect["width"])/2),cy=(int)(Convert.ToDouble(rect["y"])+Convert.ToDouble(rect["height"])/2);
                item["visibleAtPoint"]=GetAncestor(WindowFromPoint(new POINT {X=cx,Y=cy}),2).ToInt64()==hwnd;
                string nativeClass=Convert.ToString(item["nativeClass"]),automationId=Convert.ToString(item["automationId"]);
                item["source"]=kind=="desktop"&&role=="ControlType.ListItem"?"desktop-shortcut":kind=="taskbar"?(nativeClass.StartsWith("SystemTray.",StringComparison.OrdinalIgnoreCase)||automationId=="NotifyItemIcon"?"notification-area":nativeClass.IndexOf("TaskListButton",StringComparison.OrdinalIgnoreCase)>=0||automationId.StartsWith("Appid:",StringComparison.OrdinalIgnoreCase)?"taskbar-application":"taskbar-control"):"window-element";item["windowId"]=hwnd;matches.Add(item);
            }
            if(matches.Count>0)groups.Add(Obj("observation",observed,"matches",matches));
        }
        return Obj("groups",groups,"matchingWindows",matching);
    }
    static object Inspect(Dictionary<string,object> a) {
        var cited=Cited(a);var s=cited;
        if(cited.Screen){if(!cited.Targets.TryGetValue(Convert.ToInt64(a["windowId"]),out s))throw new Failure("TARGET_NOT_OBSERVED","目标必须来自 screen.windows");Verify(s);}
        int x=Num(a,"x"),y=Num(a,"y");AutomationElement element=null;
        if(a.ContainsKey("elementId")){if(cited.Screen)throw new Failure("WINDOW_OBSERVATION_REQUIRED","elementId 请使用窗口 observe 或 locate");element=Element(a,s);var r=element.Current.BoundingRectangle;x=(int)(r.X+r.Width/2);y=(int)(r.Y+r.Height/2);}
        else if(!a.ContainsKey("x")||!a.ContainsKey("y"))throw new Failure("COORDINATES_REQUIRED","prepare 需要 elementId 或绝对 x/y");
        // Read-only hit testing; never activate, move the cursor, or inject input.
        if(x<s.Rect.Left||x>=s.Rect.Right||y<s.Rect.Top||y>=s.Rect.Bottom)throw new Failure("OUT_OF_WINDOW","坐标在目标窗口外");
        if(GetAncestor(WindowFromPoint(new POINT {X=x,Y=y}),2).ToInt64()!=s.Hwnd)throw new Failure("TARGET_OCCLUDED","这个坐标实际属于其他窗口，请重新观察");
        string chosenId=a.ContainsKey("elementId")?Str(a,"elementId"):null;
        object window=Obj("windowId",s.Hwnd,"title",Title(new IntPtr(s.Hwnd)),"className",ClassName(new IntPtr(s.Hwnd)),"processId",s.Pid);
        if(element==null){
            var fresh=(Dictionary<string,object>)Observe(Obj("windowId",s.Hwnd,"maxElements",400,"budgetMs",900));window=fresh;s=observations[Convert.ToString(fresh["nativeObservation"])];
            double area=Double.MaxValue;
            foreach(var entry in s.Elements){try{var c=entry.Value.Current;var r=c.BoundingRectangle;bool clickable=c.ControlType==ControlType.Button||c.ControlType==ControlType.ListItem||c.ControlType==ControlType.MenuItem||c.ControlType==ControlType.Hyperlink;if(clickable&&!r.IsEmpty&&r.Contains(x,y)&&c.IsEnabled&&!c.IsOffscreen&&!String.IsNullOrEmpty(c.Name)&&r.Width*r.Height<area){area=r.Width*r.Height;chosenId=entry.Key;}}catch(Exception){}}
            if(chosenId!=null){element=Element(Obj("elementId",chosenId),s);var r=element.Current.BoundingRectangle;x=(int)(r.X+r.Width/2);y=(int)(r.Y+r.Height/2);}
        }
        string name="",role="",nativeClass=ClassName(WindowFromPoint(new POINT {X=x,Y=y}));object rect=null;
        try{if(element==null)element=AutomationElement.FromPoint(new System.Windows.Point(x,y));var c=element.Current;name=c.IsPassword?"[password]":c.Name;role=c.ControlType.ProgrammaticName;var r=c.BoundingRectangle;rect=Obj("x",r.X,"y",r.Y,"width",r.Width,"height",r.Height);}catch(Exception){ }
        return Obj("windowId",s.Hwnd,"elementId",chosenId,"name",name,"role",role,"nativeClass",nativeClass,"rect",rect,"source",name.Length==0?"unidentified-screen-point":Shell(s)?"shell-screen-point":"window-element","point",Obj("x",x,"y",y),"window",window);
    }
    static Stamp Cited(Dictionary<string, object> a) {
        Stamp s; if(!observations.TryGetValue(Str(a, "nativeObservation"), out s)) throw new Failure("INVALID_OBSERVATION", "原生观察不存在，请重新观察");
        Verify(s);VerifyRevision(s); return s;
    }
    static AutomationElement Element(Dictionary<string, object> a, Stamp s) {
        AutomationElement e; if(!s.Elements.TryGetValue(Str(a, "elementId"), out e)) throw new Failure("ELEMENT_REQUIRED", "请选择观察结果中的 elementId");
        var c = e.Current;
        if(c.ProcessId != s.Pid || !c.IsEnabled) throw new Failure("ELEMENT_CHANGED", "控件已改变或禁用");
        if(s.Fingerprints[Str(a,"elementId")]!=String.Join(",",e.GetRuntimeId())+"|"+c.ControlType.Id+"|"+c.Name) throw new Failure("ELEMENT_CHANGED","控件身份或名称改变，请重新观察");
        RECT observedRect;var currentRect=c.BoundingRectangle;if(s.ElementRects.TryGetValue(Str(a,"elementId"),out observedRect)&&!currentRect.IsEmpty&&(Math.Abs(currentRect.Left-observedRect.Left)>1||Math.Abs(currentRect.Top-observedRect.Top)>1||Math.Abs(currentRect.Right-observedRect.Right)>1||Math.Abs(currentRect.Bottom-observedRect.Bottom)>1))throw new Failure("ELEMENT_MOVED","控件位置已改变，请重新观察后再审批");
        var ancestor = e; int depth = 0;
        while(ancestor != null && depth++ < 64) { if(ancestor.Current.NativeWindowHandle == s.Hwnd) return e; ancestor = TreeWalker.RawViewWalker.GetParent(ancestor); }
        throw new Failure("ELEMENT_CHANGED", "控件已移出目标窗口");
    }
    static object Screenshot(Dictionary<string, object> a) {
        if(!a.ContainsKey("windowId")) {
            var screen=Cited(a); if(!screen.Screen) throw new Failure("SCREEN_REQUIRED","请先 screen");
            int sw=screen.Rect.Right-screen.Rect.Left,sh=screen.Rect.Bottom-screen.Rect.Top;
            if(sw<1||sh<1||sw>16000||sh>16000||(long)sw*sh>64000000) throw new Failure("CAPTURE_UNAVAILABLE","屏幕尺寸超出截图限制");
            using(var bitmap=CaptureCleanDesktop(screen.Rect)) {
                Verify(screen);
                var saved=(Dictionary<string,object>)SaveCapture(bitmap,screen.Rect,a);saved["capture"]="visible-screen";return saved;
            }
        }
        var s = Identity(Convert.ToInt64(a["windowId"])); int width = s.Rect.Right - s.Rect.Left, height = s.Rect.Bottom - s.Rect.Top;
        if(IsIconic(new IntPtr(s.Hwnd)) || width < 1 || height < 1 || width > 10000 || height > 10000) throw new Failure("CAPTURE_UNAVAILABLE", "目标最小化或尺寸不支持");
        using(var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using(var graphics = Graphics.FromImage(bitmap)) {
                IntPtr dc = graphics.GetHdc(); bool captured;
                try { captured = PrintWindow(new IntPtr(s.Hwnd), dc, 2); } finally { graphics.ReleaseHdc(dc); }
                if(!captured) throw new Failure("CAPTURE_UNAVAILABLE", "窗口不支持后台截图");
            }
            return SaveCapture(bitmap,s.Rect,a);
        }
    }
    static object Action(string action, Dictionary<string, object> a) {
        RequireLease(); var s = Cited(a); string mode = Str(a, "mode", "uia");
        if(mode != "uia" && mode != "mouse") throw new Failure("INVALID_MODE", "模式必须为 uia 或 mouse");
        if(s.Screen) return ScreenAction(action,a,s,mode);
        if(mode == "uia") {
            IntPtr previousForeground=GetForegroundWindow(); uint previousInput=LastInput();
            try {
            var e = Element(a, s); object p; Verify(s); Check();
            if(action == "click") {
                if(Str(a,"button","left")!="left" || Num(a,"count",1)!=1) throw new Failure("UIA_UNSUPPORTED","右键和多次点击需要 mouse 模式");
                if(e.Current.ControlType==ControlType.Button && NativeClass(e,"BUTTON")) { UIntPtr result; if(SendMessageTimeout(new IntPtr(e.Current.NativeWindowHandle),0x00F5,IntPtr.Zero,IntPtr.Zero,0x2,3000,out result)==IntPtr.Zero) throw new Failure("PARTIAL_DELIVERY","后台按钮消息未确认，不可自动重放"); }
                else if(e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) ((InvokePattern)p).Invoke();
                else if(e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) ((TogglePattern)p).Toggle();
                else if(e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) ((SelectionItemPattern)p).Select();
                else throw new Failure("UIA_UNSUPPORTED", "控件没有可后台点击的模式；可显式选择 mouse");
            } else if(action == "type") {
                if(!e.TryGetCurrentPattern(ValuePattern.Pattern, out p) || ((ValuePattern)p).Current.IsReadOnly) throw new Failure("UIA_UNSUPPORTED", "控件不支持后台写入；可显式选择 mouse");
                string text = Str(a, "text"); if(Str(a, "replace", "True").ToLower() == "false") text = ((ValuePattern)p).Current.Value + text;
                if(e.Current.ControlType==ControlType.Edit && NativeClass(e,"EDIT")) { UIntPtr result; if(SendTextTimeout(new IntPtr(e.Current.NativeWindowHandle),0x000C,IntPtr.Zero,text,0x2,3000,out result)==IntPtr.Zero) throw new Failure("PARTIAL_DELIVERY","后台文字消息未确认，不可自动重放"); }
                else ((ValuePattern)p).SetValue(text);
            } else if(action == "scroll") {
                if(!e.TryGetCurrentPattern(ScrollPattern.Pattern, out p)) throw new Failure("UIA_UNSUPPORTED", "控件不支持后台滚动");
                ((ScrollPattern)p).Scroll(Num(a, "deltaX") == 0 ? ScrollAmount.NoAmount : Num(a, "deltaX") > 0 ? ScrollAmount.LargeIncrement : ScrollAmount.LargeDecrement, Num(a, "deltaY") == 0 ? ScrollAmount.NoAmount : Num(a, "deltaY") > 0 ? ScrollAmount.LargeIncrement : ScrollAmount.LargeDecrement);
            } else throw new Failure("UIA_UNSUPPORTED", "该动作需要 mouse 模式");
            } finally {
                // Some providers call SetFocus inside Invoke/SetValue. Restore
                // only the provider-owned target transition, never new human input.
                Thread.Sleep(120);
                IntPtr changedForeground=GetForegroundWindow();
                bool shouldRestore=previousForeground!=new IntPtr(s.Hwnd) && IsWindow(previousForeground) && GetAncestor(changedForeground,2)==new IntPtr(s.Hwnd) && LastInput()==previousInput;
                if(shouldRestore) RequestForeground(previousForeground);
            }
        } else {
            Busy();
            int x = Num(a, "x"), y = Num(a, "y");
            if(a.ContainsKey("elementId")) { var r = Element(a, s).Current.BoundingRectangle; x = (int)(r.X + r.Width / 2); y = (int)(r.Y + r.Height / 2); }
            if(action!="key"&&(action!="type"||a.ContainsKey("elementId"))) {
                if(IsIconic(new IntPtr(s.Hwnd))) throw new Failure("WINDOW_MINIMIZED","目标已最小化，请 observe 后 activate，或 screen 点击任务栏");
                if(GetAncestor(WindowFromPoint(new POINT {X=x,Y=y}),2).ToInt64()!=s.Hwnd) throw new Failure("TARGET_OCCLUDED","目标位置被遮挡，请先 screen 查看可见目标，不自动抬升窗口绕过遮挡");
                VerifyElementHit(s,a,x,y);
            }
            if(!Shell(s)||action=="key"||action=="type") Foreground(s);
            if(action == "click" || action == "hover" || action == "scroll" || action == "drag") {
                var move = Move(s, x, y); Busy();
                VerifyElementHit(s,a,x,y);
                uint down = 2, up = 4; string button = Str(a, "button", "left");
                if(button == "right") { down = 8; up = 16; } else if(button == "middle") { down = 32; up = 64; } else if(button != "left") throw new Failure("INVALID_BUTTON", "未知鼠标键");
                if(action == "click") { int count = Num(a, "count", 1); if(count < 1 || count > 3) throw new Failure("INVALID_COUNT", "点击次数必须为 1..3"); for(int i = 0; i < count; i++) { Input(new INPUT[] {Move(s,x,y), Mouse(down), Mouse(up)}); if(i+1 < count) Thread.Sleep(60); } }
                else if(action == "hover") Input(new INPUT[] {move});
                else if(action == "scroll") {
                    if(a.ContainsKey("elementId")) { var target=Element(a,s); if(target.Current.IsKeyboardFocusable) target.SetFocus(); }
                    Input(new INPUT[] {Move(s,x,y)}); Thread.Sleep(50); Verify(s);
                    if(!Shell(s)&&!OwnsForeground(s)) throw new Failure("FOCUS_CHANGED","滚动期间用户切换了窗口");
                    int dy = Num(a, "deltaY"), dx = Num(a, "deltaX"); if(dy != 0) Input(new INPUT[] {Mouse(0x800,0,0,unchecked((uint)-dy))}); if(dx != 0) Input(new INPUT[] {Mouse(0x1000,0,0,unchecked((uint)dx))});
                }
                else {
                    int ex = Num(a,"endX"), ey = Num(a,"endY"); Move(s,ex,ey);
                    Input(new INPUT[] {move, Mouse(down)});
                    try { int lastX=x,lastY=y; for(int i=1;i<=20;i++) { POINT actual; GetCursorPos(out actual); if(Math.Abs(actual.X-lastX)>3||Math.Abs(actual.Y-lastY)>3) throw new Failure("HUMAN_INPUT_BUSY","用户移动了鼠标，已中止拖拽"); lastX=x+(ex-x)*i/20; lastY=y+(ey-y)*i/20; Input(new INPUT[] {Move(s,lastX,lastY)}); Thread.Sleep(15); } }
                    finally { Release(new INPUT[] {Mouse(up)}); }
                }
            } else if(action == "type") {
                string text = Str(a,"text"); if(text.Length > 20000) throw new Failure("TEXT_TOO_LONG", "单次输入限 20000 字符");
                if(a.ContainsKey("elementId")) { var move=Move(s,x,y); VerifyElementHit(s,a,x,y); Input(new INPUT[] {move, Mouse(2),Mouse(4)}); }
                if(Str(a,"replace","False").ToLower()=="true") Chord(s,"CTRL+A");
                foreach(char c in text) { Verify(s); if(!OwnsForeground(s)) throw new Failure("PARTIAL_DELIVERY","前台已改变；文字可能部分输入，不可重放"); Input(new INPUT[] {Key(0,false,c,true),Key(0,true,c,true)}); }
            } else if(action == "key") Chord(s,Str(a,"key"));
            else throw new Failure("UNKNOWN_ACTION", "未知输入动作");
        }
        return Obj("performed", true, "mode", mode, "windowId", s.Hwnd);
    }
    static INPUT ScreenMove(Stamp screen,Stamp target,int x,int y) {
        Verify(screen); Verify(target);
        if(IsIconic(new IntPtr(target.Hwnd))) throw new Failure("WINDOW_MINIMIZED","目标最小化；请点击任务栏窗口中的按钮，或 observe 应用后 activate");
        if(x<screen.Rect.Left||x>=screen.Rect.Right||y<screen.Rect.Top||y>=screen.Rect.Bottom||x<target.Rect.Left||x>=target.Rect.Right||y<target.Rect.Top||y>=target.Rect.Bottom) throw new Failure("OUT_OF_WINDOW","坐标不在观察中的目标窗口内；不能借用其他窗口发送鼠标");
        if(GetAncestor(WindowFromPoint(new POINT {X=x,Y=y}),2).ToInt64()!=target.Hwnd) throw new Failure("TARGET_OCCLUDED","屏幕点击位置属于其他窗口，请重新 screen 并选择真实目标");
        return Absolute(x,y);
    }
    static object ScreenAction(string action,Dictionary<string,object> a,Stamp screen,string mode) {
        if(mode!="mouse") throw new Failure("SCREEN_REQUIRES_MOUSE","screen 观察仅用于 mouse 模式");
        Stamp target;
        long hwnd=a.ContainsKey("windowId")?Convert.ToInt64(a["windowId"]):0;
        if(!screen.Targets.TryGetValue(hwnd,out target)) throw new Failure("TARGET_NOT_OBSERVED","windowId 必须来自此 screen.windows");
        Verify(screen);Verify(target);Busy();
        if(a.ContainsKey("elementId")) throw new Failure("SCREEN_COORDINATES_REQUIRED","screen 使用绝对 x/y；elementId 请引用具体窗口 observe");
        if(action=="key") {
            if(target.Hwnd!=screen.Foreground||!OwnsForeground(target)) throw new Failure("FOCUS_CHANGED","全屏按键必须绑定观察时且现在仍在前台的窗口，不能激活桌面作为载体");
            Chord(target,Str(a,"key"));
        } else {
            if(!a.ContainsKey("x")||!a.ContainsKey("y")) throw new Failure("SCREEN_COORDINATES_REQUIRED","全屏鼠标操作需要绝对 x/y");
            int x=Num(a,"x"),y=Num(a,"y"); var move=ScreenMove(screen,target,x,y);
            uint down=2,up=4; string button=Str(a,"button","left");
            if(button=="right") {down=8;up=16;} else if(button=="middle") {down=32;up=64;} else if(button!="left") throw new Failure("INVALID_BUTTON","未知鼠标键");
            if(action=="click") {
                int count=Num(a,"count",1); if(count<1||count>3) throw new Failure("INVALID_COUNT","点击次数必须为 1..3");
                for(int i=0;i<count;i++) {Input(new INPUT[] {ScreenMove(screen,target,x,y),Mouse(down),Mouse(up)}); if(i+1<count)Thread.Sleep(60);}
            } else if(action=="hover") Input(new INPUT[] {move});
            else if(action=="scroll") {
                Input(new INPUT[] {move});Thread.Sleep(50);ScreenMove(screen,target,x,y);
                int dy=Num(a,"deltaY"),dx=Num(a,"deltaX");
                if(dy!=0) Input(new INPUT[] {Mouse(0x800,0,0,unchecked((uint)-dy))});
                if(dx!=0) Input(new INPUT[] {Mouse(0x1000,0,0,unchecked((uint)dx))});
            } else if(action=="drag") {
                if(!a.ContainsKey("endX")||!a.ContainsKey("endY")) throw new Failure("SCREEN_COORDINATES_REQUIRED","拖拽需要 endX/endY");
                int ex=Num(a,"endX"),ey=Num(a,"endY");ScreenMove(screen,target,ex,ey);
                Input(new INPUT[] {move,Mouse(down)});
                try { int lastX=x,lastY=y; for(int i=1;i<=20;i++) {POINT actual;GetCursorPos(out actual);if(Math.Abs(actual.X-lastX)>3||Math.Abs(actual.Y-lastY)>3)throw new Failure("HUMAN_INPUT_BUSY","用户移动鼠标，已中止拖拽");lastX=x+(ex-x)*i/20;lastY=y+(ey-y)*i/20;Input(new INPUT[] {ScreenMove(screen,target,lastX,lastY)});Thread.Sleep(15);} }
                finally {Release(new INPUT[] {Mouse(up)});}
            } else throw new Failure("SCREEN_ACTION_UNSUPPORTED","screen 支持 click/hover/scroll/drag/key；其他动作 observe 具体窗口");
        }
        return Obj("performed",true,"mode","mouse","windowId",target.Hwnd,"scope","screen");
    }
    static void Chord(Stamp s,string chord) {
        Verify(s); if(!OwnsForeground(s)) throw new Failure("FOCUS_CHANGED","前台已改变，停止按键");
        var map=new Dictionary<string,ushort> { {"CTRL",17},{"CONTROL",17},{"SHIFT",16},{"ALT",18},{"WIN",91},{"ENTER",13},{"RETURN",13},{"TAB",9},{"ESC",27},{"ESCAPE",27},{"BACKSPACE",8},{"DELETE",46},{"SPACE",32},{"HOME",36},{"END",35},{"LEFT",37},{"UP",38},{"RIGHT",39},{"DOWN",40},{"PAGEUP",33},{"PAGEDOWN",34} };
        var keys=new List<ushort>(); foreach(string raw in chord.Split('+')) { string k=raw.Trim().ToUpperInvariant(); ushort vk; if(map.TryGetValue(k,out vk)) keys.Add(vk); else if(k.Length==1 && ((k[0]>='A'&&k[0]<='Z')||(k[0]>='0'&&k[0]<='9'))) keys.Add(k[0]); else if(k.StartsWith("F")&&k.Length<=3) { int f; if(!int.TryParse(k.Substring(1),out f)||f<1||f>24) throw new Failure("INVALID_KEY","未知按键"); keys.Add((ushort)(111+f)); } else throw new Failure("INVALID_KEY","未知按键："+raw); }
        if(keys.Count==0||keys.Count>5) throw new Failure("INVALID_KEY","组合键无效");
        var modifiers=new List<INPUT>(); for(int i=0;i<keys.Count-1;i++) modifiers.Add(Key(keys[i],false));
        try {
            if(modifiers.Count>0) { Input(modifiers.ToArray()); Thread.Sleep(35); }
            Verify(s); if(!OwnsForeground(s)) throw new Failure("PARTIAL_DELIVERY","组合键期间前台改变，不可重放");
            Input(new INPUT[] {Key(keys[keys.Count-1],false),Key(keys[keys.Count-1],true)}); Thread.Sleep(35);
        } finally {
            var releases=new List<INPUT>(); for(int i=keys.Count-2;i>=0;i--) releases.Add(Key(keys[i],true));
            if(releases.Count>0) Release(releases.ToArray());
        }
    }
    static object Dispatch(Dictionary<string,object> a) {
        string action=Str(a,"action");
        // A completed Esc cancellation must not poison future read-only observations.
        if(!leased&&(action=="observe"||action=="screen"||action=="screenshot")&&(GetAsyncKeyState(27)&0x8000)==0) cancelled=false;
        if(action=="ping") { POINT p; GetCursorPos(out p); uint foregroundPid; GetWindowThreadProcessId(GetForegroundWindow(),out foregroundPid); return Obj("platform","win32","pid",Process.GetCurrentProcess().Id,"indicatorVisible",badge.Visible,"indicatorWindow",badge.Handle.ToInt64(),"consentVisible",consentPanel.Visible,"consentId",consentId,"consentRect",Obj("x",consentPanel.Left,"y",consentPanel.Top,"width",consentPanel.Width,"height",consentPanel.Height),"indicatorRect",Obj("x",badge.Left,"y",badge.Top,"width",badge.Width,"height",badge.Height),"phase",badge.Phase,"animationFrame",badge.Frame,"visualOwner",visualOwner,"haloVisible",halo.Visible,"edgeCount",edges.FindAll(e=>e.Visible).Count,"takeoverHooks",mouseHook!=IntPtr.Zero&&keyboardHook!=IntPtr.Zero,"captureExcluded",captureExcluded,"remoteVisible",RemoteVisible(),"captureSuspended",captureSuspended,"browserWatching",browserOwner.Length>0,"browserOwner",browserOwner,"lease",leased,"cursor",Obj("x",p.X,"y",p.Y),"foreground",GetForegroundWindow().ToInt64(),"foregroundPid",foregroundPid,"foregroundTitle",Title(GetForegroundWindow())); }
        if(action=="visual") {if((GetAsyncKeyState(27)&0x8000)!=0)throw new Failure("CANCELLED","Esc 正在按下");if(!leased)cancelled=false;object state=null;badge.Invoke(new Action(delegate {long generation=a.ContainsKey("generation")?Convert.ToInt64(a["generation"]):visualGeneration;if(generation<visualGeneration){state=Obj("visible",false,"stale",true);return;}visualGeneration=generation;SetVisual(Str(a,"owner"),Str(a,"phase","observe"),Str(a,"watchHuman","True").ToLower()=="true",true);state=Obj("visible",badge.Visible&&stopPanel.Visible&&IsWindowVisible(badge.Handle)&&IsWindowVisible(stopPanel.Handle),"painted",true,"remoteVisible",RemoteVisible(),"generation",visualGeneration,"phase",badge.Phase,"pid",Process.GetCurrentProcess().Id,"rect",Obj("x",badge.Left,"y",badge.Top,"width",badge.Width,"height",badge.Height),"monitor",Screen.FromControl(badge).DeviceName);}));return state;}
        if(action=="visual-health"){object health=null;badge.Invoke(new Action(delegate{health=Obj("visible",visualOwner==Str(a,"owner")&&badge.Visible&&stopPanel.Visible&&IsWindowVisible(badge.Handle)&&IsWindowVisible(stopPanel.Handle),"generation",visualGeneration,"phase",badge.Phase,"remoteVisible",RemoteVisible());}));return health;}
        if(action=="wait-window"){var started=DateTime.UtcNow;int waitMs=Math.Max(200,Math.Min(5000,Num(a,"waitMs",2000)));string query=Str(a,"query");bool matched=false;do{Check();if(query.Length>0){var inventory=(Dictionary<string,object>)Windows();foreach(Dictionary<string,object> window in (List<object>)inventory["windows"]){if(!Convert.ToBoolean(window["minimized"])&&Convert.ToString(window["title"]).StartsWith(query,StringComparison.OrdinalIgnoreCase)){matched=true;break;}}}if(matched)break;Thread.Sleep(100);}while((DateTime.UtcNow-started).TotalMilliseconds<waitMs);return Obj("matched",matched,"timedOut",!matched,"elapsedMs",(int)(DateTime.UtcNow-started).TotalMilliseconds,"query",query);}
        // Test-only protocol action: prove compositor pixels, not DrawToBitmap or HWND flags.
        if(action=="visual-desktop-proof"){object proof=null;badge.Invoke(new Action(delegate{if(!badge.Visible)throw new Failure("INDICATOR_UNAVAILABLE","没有可验证的悬浮提示");uint affinity;GetWindowDisplayAffinity(badge.Handle,out affinity);DwmFlush();using(var bitmap=new Bitmap(badge.Width,badge.Height)){using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(badge.Location,Point.Empty,bitmap.Size);int dark=0;for(int y=4;y<bitmap.Height-4;y+=2)for(int x=4;x<420;x+=2){var c=bitmap.GetPixel(x,y);if(c.R<45&&c.G<55&&c.B<70)dark++;}using(var stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);proof=Obj("compositorVerified",dark>4000,"darkSamples",dark,"affinity",affinity,"remoteVisible",RemoteVisible(),"pngBase64",Convert.ToBase64String(stream.ToArray()),"width",bitmap.Width,"height",bitmap.Height,"phase",badge.Phase);}}}));return proof;}
        if(action=="visual-stop") {string owner=Str(a,"owner");badge.Invoke(new Action(delegate {long generation=a.ContainsKey("generation")?Convert.ToInt64(a["generation"]):visualGeneration;if(generation<visualGeneration)return;visualGeneration=generation;if(visualOwner==owner)HideVisuals();}));return Obj("hidden",true);}
        if(action=="consent"){badge.Invoke(new Action(delegate{consentOwner=Str(a,"owner");consentId=Str(a,"requestId");SetVisual(consentOwner,"approval",false,true);consentPanel.Summary.Text=Str(a,"summary");var area=Screen.FromControl(badge).WorkingArea;consentPanel.Location=new Point(area.Left+(area.Width-consentPanel.Width)/2,badge.Bottom+8);consentPanel.Show();ShowWindow(consentPanel.Handle,4);}));return Obj("visible",true);}
        if(action=="consent-hide"){badge.Invoke(new Action(delegate{if(consentId==Str(a,"requestId")){consentPanel.Hide();consentId="";}}));return Obj("hidden",true);}
        if(action=="visual-screenshot") {object shot=null;badge.Invoke(new Action(delegate {using(var bitmap=new Bitmap(badge.Width,badge.Height)){badge.DrawToBitmap(bitmap,badge.ClientRectangle);using(var stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);shot=Obj("pngBase64",Convert.ToBase64String(stream.ToArray()),"width",bitmap.Width,"height",bitmap.Height,"phase",badge.Phase,"frame",badge.Frame);}}}));return shot;}
        if(action=="begin") {
            if(leased) throw new Failure("CONTROL_BUSY","当前进程已持有控制权");
            if((GetAsyncKeyState(27)&0x8000)!=0) throw new Failure("CANCELLED","Esc 正在按下");
            bool taken=false; try { taken=lease.WaitOne(0); } catch(AbandonedMutexException) { taken=true; }
            if(!taken) throw new Failure("CONTROL_BUSY","其他 DSH 进程正在控制输入"); leased=true; cancelled=false;
            string kind=Str(a,"kind","uia"), owner=Str(a,"owner");
            badge.Invoke(new Action(delegate {SetVisual(owner,kind,true,continuous);}));
            return Obj("acquired",true,"owner",owner,"kind",kind);
        }
        if(action=="end") { ReleaseOwned(); if(leased) { lease.ReleaseMutex(); leased=false; } badge.Invoke(new Action(delegate {if(continuous&&badge.Visible)SetVisual(visualOwner,"thinking",true,true);else {halo.Hide();foreach(var edge in edges)edge.Hide();badge.Message="控制权已释放";badgeUntil=DateTime.UtcNow.AddMilliseconds(Math.Max(0,Math.Min(30000,Num(a,"idleMs",1000))));badge.Invalidate();}})); return Obj("released",true); }
        if(action=="hide") { badge.Invoke(new Action(delegate { HideVisuals(); })); return Obj("hidden",true); }
        if(action=="windows") return Windows();
        if(action=="locate")return Locate(a);
        if(action=="inspect")return Inspect(a);
        if(action=="screen") return ScreenObservation();
        if(action=="observe") return Observe(a);
        if(action=="wait-for")return WaitFor(a);
        if(action=="check-element"){var s=Cited(a);var element=Element(a,s);if(!element.Current.IsEnabled)throw new Failure("ELEMENT_DISABLED","控件不可用");return Obj("valid",true,"windowId",s.Hwnd);}
        if(action=="strokes"||action=="drag"&&(a.ContainsKey("path")||a.ContainsKey("strokes")))return DrawPaths(a);
        if(action=="watch-status")return Obj("watchedWindows",watches.Count,"uiChanges",Interlocked.Read(ref uiChanges),"focusChanges",Interlocked.Read(ref focusChanges),"focusMonitoring",focusHandler!=null);
        if(action=="browser-watch"){browserOwner=Str(a,"owner");browserProcessId=Convert.ToUInt32(a["processId"]);browserWatchHuman=Str(a,"watchHuman","True").ToLower()=="true";return Obj("watching",true,"visible",false);}
        if(action=="browser-watch-stop"){if(browserOwner==Str(a,"owner"))browserOwner="";return Obj("watching",false);}
        if(action=="capture-policy-proof")return CapturePolicyProof();
        if(action=="screenshot") return Screenshot(a);
        if(action=="activate"||action=="restore") { RequireLease(); var s=Cited(a); if(s.Screen)throw new Failure("WINDOW_OBSERVATION_REQUIRED","激活/还原请 observe 具体窗口"); bool minimized=IsIconic(new IntPtr(s.Hwnd)); Restore(s); if(minimized){Stamp removed;observations.TryRemove(Str(a,"nativeObservation"),out removed);} if(action=="activate")Foreground(s); return Obj("activated",action=="activate","restored",minimized,"windowId",s.Hwnd); }
        if(action=="launch") { RequireLease(); string file=Str(a,"file"); if(file.Length==0) throw new Failure("INVALID_APP","缺少程序路径"); var info=new ProcessStartInfo(file) { UseShellExecute=false, Arguments=Str(a,"arguments") }; var p=Process.Start(info); return Obj("processId",p.Id); }
        if(action=="shutdown") { stopping=true; if(leased){lease.ReleaseMutex();leased=false;} badge.BeginInvoke(new Action(delegate { badge.Close(); Application.ExitThread(); })); return Obj("stopped",true); }
        return Action(action,a);
    }
    public static void Run() {
        SetProcessDPIAware();
        ui=new Thread(delegate() {
            badge=new Badge(); var handle=badge.Handle;
            stopPanel=new StopPanel();var stopHandle=stopPanel.Handle;
            consentPanel=new ConsentPanel();var consentHandle=consentPanel.Handle;
            halo=new VisualLayer(true){Size=new Size(72,72)};var haloHandle=halo.Handle;
            foreach(var display in Screen.AllScreens){var r=display.Bounds;foreach(var bounds in new Rectangle[]{new Rectangle(r.Left,r.Top,r.Width,3),new Rectangle(r.Left,r.Bottom-3,r.Width,3),new Rectangle(r.Left,r.Top,3,r.Height),new Rectangle(r.Right-3,r.Top,3,r.Height)}){var edge=new VisualLayer(false){Bounds=bounds};var edgeHandle=edge.Handle;edges.Add(edge);}}
            // Global capture exclusion also hides controls from remote users.
            // Keep all surfaces recordable; hide them only inside our own capture.
            foreach(var surface in VisualSurfaces())SetWindowDisplayAffinity(surface.Handle,0);
            captureExcluded=false;
            badge.Stop.Click+=delegate {Takeover("stop-button");};
            stopPanel.Stop.Click+=delegate {Takeover("stop-button");};
            consentPanel.Once.Click+=delegate{Write(Obj("event","consent","owner",consentOwner,"id",consentId,"choice","once"));};consentPanel.Same.Click+=delegate{Write(Obj("event","consent","owner",consentOwner,"id",consentId,"choice","same"));};consentPanel.Reject.Click+=delegate{Write(Obj("event","consent","owner",consentOwner,"id",consentId,"choice","reject"));};
            mouseProc=MouseHook;keyboardProc=KeyboardHook;mouseHook=SetWindowsHookEx(14,mouseProc,GetModuleHandle(null),0);keyboardHook=SetWindowsHookEx(13,keyboardProc,GetModuleHandle(null),0);
            badge.TakeoverAvailable=mouseHook!=IntPtr.Zero&&keyboardHook!=IntPtr.Zero;
            timer=new System.Windows.Forms.Timer { Interval=40 };
            timer.Tick+=delegate {
                bool down=(GetAsyncKeyState(27)&0x8000)!=0;
                if(down&&!escWasDown&&badge.Visible) Takeover("escape");
                if(down&&!escWasDown&&BrowserWindow(GetForegroundWindow()))BrowserTakeover("browser-escape");
                escWasDown=down;if(badge.Visible&&DateTime.UtcNow>badgeUntil)HideVisuals();
                if(badge.Visible){badge.Frame++;badge.Invalidate();foreach(var edge in edges){edge.Opacity=0.65+0.2*Math.Sin(badge.Frame*0.1);edge.Invalidate();}}
                if(badge.Visible&&badge.Frame%8==0){SetWindowPos(badge.Handle,new IntPtr(-1),0,0,0,0,0x1|0x2|0x10);SetWindowPos(stopPanel.Handle,new IntPtr(-1),0,0,0,0,0x1|0x2|0x10);if(consentPanel.Visible)SetWindowPos(consentPanel.Handle,new IntPtr(-1),0,0,0,0,0x1|0x2|0x10);}
                if(halo.Visible){POINT p;GetCursorPos(out p);halo.Location=new Point(p.X-35,p.Y-35);halo.Frame=badge.Frame;halo.Invalidate();}
            };
            timer.Start(); ready.Set(); Application.Run();timer.Dispose();if(mouseHook!=IntPtr.Zero)UnhookWindowsHookEx(mouseHook);if(keyboardHook!=IntPtr.Zero)UnhookWindowsHookEx(keyboardHook);foreach(var edge in edges)edge.Dispose();halo.Dispose();stopPanel.Dispose();consentPanel.Dispose();badge.Dispose();
        });
        ui.SetApartmentState(ApartmentState.STA); ui.IsBackground=true; ui.Start(); ready.WaitOne();StartFocusWatch();
        // A dedicated reader can cancel an in-flight UIA/drag operation. It does
        // not wait for that operation to finish before releasing owned inputs.
        var requests=new BlockingCollection<Dictionary<string,object>>();
        var reader=new Thread(delegate() { var parser=new JavaScriptSerializer {MaxJsonLength=32*1024*1024,RecursionLimit=64}; try { string line; while(!stopping&&(line=Console.ReadLine())!=null) { try { var a=parser.Deserialize<Dictionary<string,object>>(line); if(Str(a,"action")=="cancel") { Cancel(); continue; } requests.Add(a); } catch(Exception e) { Write(Obj("id",null,"ok",false,"code","NATIVE_ERROR","error",e.Message)); } } } finally { requests.CompleteAdding(); } });
        reader.IsBackground=true; reader.Start();
        foreach(var a in requests.GetConsumingEnumerable()) {
            if(stopping) break;
            object id=null;
            try { id=a["id"]; Write(Obj("id",id,"ok",true,"data",Dispatch(a))); }
            catch(Exception error) { var failure=error as Failure; Write(Obj("id",id,"ok",false,"code",failure==null?"NATIVE_ERROR":failure.Code,"error",error.Message)); }
        }
        ReleaseOwned(); if(leased) { lease.ReleaseMutex(); leased=false; }
        if(!stopping&&badge!=null&&!badge.IsDisposed) badge.BeginInvoke(new Action(delegate { badge.Close(); Application.ExitThread(); }));
        StopWatches();ui.Join(1000); lease.Dispose();
    }
}
}
