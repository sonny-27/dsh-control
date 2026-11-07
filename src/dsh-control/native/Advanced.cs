using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace DshControl {
public sealed class WindowWatch {
    public long Hwnd,Start,Version;
    public AutomationElement Root;
    public StructureChangedEventHandler Structure;
    public AutomationPropertyChangedEventHandler Property;
    public bool Available;
}
public static partial class Host {
    static volatile string browserOwner="";static uint browserProcessId;static bool browserWatchHuman;
    static void BrowserTakeover(string reason){var owner=browserOwner;if(owner.Length==0)return;browserOwner="";Write(Obj("event","takeover","owner",owner,"reason",reason));}
    static bool BrowserWindow(IntPtr window){uint process;GetWindowThreadProcessId(GetAncestor(window,2),out process);return browserOwner.Length>0&&process==browserProcessId;}
    static IEnumerable<Form> VisualSurfaces(){yield return badge;yield return stopPanel;yield return consentPanel;yield return halo;foreach(var edge in edges)yield return edge;}
    static bool RemoteVisible(){foreach(var surface in VisualSurfaces()){uint affinity;if(!GetWindowDisplayAffinity(surface.Handle,out affinity)||affinity!=0)return false;}return true;}
    static Bitmap CaptureCleanDesktop(RECT rect){
        Bitmap captured=null;Exception failure=null;
        badge.Invoke(new Action(delegate{
            var visible=new List<Form>();string owner=visualOwner;
            foreach(var surface in VisualSurfaces())if(surface.Visible)visible.Add(surface);
            captureSuspended=visible.Count>0;
            try{foreach(var surface in visible)surface.Hide();DwmFlush();captured=new Bitmap(rect.Right-rect.Left,rect.Bottom-rect.Top,PixelFormat.Format32bppArgb);using(var graphics=Graphics.FromImage(captured))graphics.CopyFromScreen(rect.Left,rect.Top,0,0,captured.Size,CopyPixelOperation.SourceCopy);}
            catch(Exception error){failure=error;}
            finally{
                captureSuspended=false;
                // Never restore a stopped, cancelled, or replaced intervention.
                if(owner==visualOwner&&!cancelled&&!stopping){foreach(var surface in visible){surface.Show();ShowWindow(surface.Handle,4);SetWindowPos(surface.Handle,new IntPtr(-1),0,0,0,0,0x1|0x2|0x10|0x40);}badge.Update();stopPanel.Update();DwmFlush();}
            }
        }));
        if(failure!=null){if(captured!=null)captured.Dispose();throw failure;}return captured;
    }
    static object CapturePolicyProof(){
        Bitmap before=null;Rectangle hud=Rectangle.Empty;bool remote=false;
        badge.Invoke(new Action(delegate{if(!badge.Visible)throw new Failure("INDICATOR_UNAVAILABLE","提示没有显示");hud=badge.Bounds;remote=RemoteVisible();DwmFlush();before=new Bitmap(hud.Width,hud.Height);using(var graphics=Graphics.FromImage(before))graphics.CopyFromScreen(hud.Location,Point.Empty,hud.Size);}));
        var desktop=ScreenRect();int changed=0,total=0;
        using(before)using(var clean=CaptureCleanDesktop(desktop)){
            for(int y=4;y<hud.Height-4;y+=2)for(int x=4;x<hud.Width-4;x+=2){int cx=hud.Left-desktop.Left+x,cy=hud.Top-desktop.Top+y;if(cx<0||cy<0||cx>=clean.Width||cy>=clean.Height)continue;total++;if(before.GetPixel(x,y).ToArgb()!=clean.GetPixel(cx,cy).ToArgb())changed++;}
        }
        bool restored=false;badge.Invoke(new Action(delegate{restored=badge.Visible&&stopPanel.Visible&&RemoteVisible();}));
        return Obj("remoteVisibleBefore",remote,"remoteVisibleAfter",restored,"ownCaptureOmittedHUD",changed>total/2,"differentSamples",changed,"samples",total,"captureSuspended",captureSuspended);
    }
    static ConcurrentDictionary<long,WindowWatch> watches=new ConcurrentDictionary<long,WindowWatch>();
    static AutomationFocusChangedEventHandler focusHandler;
    static long focusChanges,uiChanges;
    static void Changed(WindowWatch watch,string kind,object sender,AutomationPropertyChangedEventArgs property) {
        long version=Interlocked.Increment(ref watch.Version);Interlocked.Increment(ref uiChanges);
        string identity=null;object current=null;bool gotCurrent=false;
        if(property!=null){try{var element=sender as AutomationElement;if(element!=null){identity=String.Join(",",element.GetRuntimeId());current=element.GetCurrentPropertyValue(property.Property);gotCurrent=true;}}catch(Exception){}}
        var invalid=new List<string>();
        foreach(var pair in observations){var stamp=pair.Value;if(stamp.Hwnd!=watch.Hwnd&&!(stamp.Screen&&stamp.Targets.ContainsKey(watch.Hwnd)))continue;
            bool changed=true;Dictionary<int,object> snapshot;object prior;
            if(gotCurrent&&!stamp.Screen){if(!stamp.PropertySnapshots.TryGetValue(identity,out snapshot))changed=false;else if(snapshot.TryGetValue(property.Property.Id,out prior))changed=!Object.Equals(prior,current);}
            if(changed){stamp.Invalid=true;invalid.Add(pair.Key);}
        }
        Write(Obj("event","ui-change","windowId",watch.Hwnd,"version",version,"kind",kind,"sourcePid",Process.GetCurrentProcess().Id,"nativeObservations",invalid));
    }
    static WindowWatch WatchWindow(Stamp stamp) {
        WindowWatch found;
        if(watches.TryGetValue(stamp.Hwnd,out found)&&found.Start==stamp.Start)return found;
        if(found!=null)RemoveWatch(found);
        var watch=new WindowWatch {Hwnd=stamp.Hwnd,Start=stamp.Start};
        watches[stamp.Hwnd]=watch;
        try {
            watch.Root=AutomationElement.FromHandle(new IntPtr(stamp.Hwnd));
            watch.Structure=delegate(object sender,StructureChangedEventArgs e){Changed(watch,"structure",sender,null);};
            watch.Property=delegate(object sender,AutomationPropertyChangedEventArgs e){Changed(watch,"property",sender,e);};
            Automation.AddStructureChangedEventHandler(watch.Root,TreeScope.Subtree,watch.Structure);
            Automation.AddAutomationPropertyChangedEventHandler(watch.Root,TreeScope.Subtree,watch.Property,
                AutomationElement.NameProperty,AutomationElement.IsEnabledProperty,AutomationElement.IsOffscreenProperty,
                AutomationElement.BoundingRectangleProperty,ValuePattern.ValueProperty,TogglePattern.ToggleStateProperty,SelectionItemPattern.IsSelectedProperty);
            watch.Available=true;
        }catch(Exception){RemoveWatch(watch);watch.Available=false;}
        if(watches.Count>16){foreach(var pair in watches){if(pair.Key!=stamp.Hwnd){WindowWatch removed;if(watches.TryRemove(pair.Key,out removed))RemoveWatch(removed);break;}}}
        return watch;
    }
    static void RemoveWatch(WindowWatch watch) {
        try{if(watch.Structure!=null&&watch.Root!=null)Automation.RemoveStructureChangedEventHandler(watch.Root,watch.Structure);}catch(Exception){}
        try{if(watch.Property!=null&&watch.Root!=null)Automation.RemoveAutomationPropertyChangedEventHandler(watch.Root,watch.Property);}catch(Exception){}
    }
    static void StartFocusWatch() {
        focusHandler=delegate(object sender,AutomationFocusChangedEventArgs e){
            try{var element=sender as AutomationElement;long hwnd=element==null?0:element.Current.NativeWindowHandle;var foreground=GetForegroundWindow();if(IsVisual(foreground))return;
                Interlocked.Increment(ref focusChanges);Write(Obj("event","focus-change","windowId",foreground.ToInt64(),"elementWindowId",hwnd));
            }catch(Exception){}
        };
        try{Automation.AddAutomationFocusChangedEventHandler(focusHandler);}catch(Exception){focusHandler=null;}
    }
    static void StopWatches(){foreach(var watch in watches.Values)RemoveWatch(watch);watches.Clear();try{if(focusHandler!=null)Automation.RemoveAutomationFocusChangedEventHandler(focusHandler);}catch(Exception){}focusHandler=null;}
    static void VerifyRevision(Stamp stamp) {
        if(stamp.Invalid)throw new Failure("UI_CHANGED","界面结构或属性已改变，请重新观察，不能重放旧输入");
    }
    static Dictionary<int,object> SnapshotProperties(AutomationElement element,AutomationElement.AutomationElementInformation info,bool cached,string text){
        var values=new Dictionary<int,object>{{AutomationElement.NameProperty.Id,info.Name},{AutomationElement.IsEnabledProperty.Id,info.IsEnabled},{AutomationElement.IsOffscreenProperty.Id,info.IsOffscreen},{AutomationElement.BoundingRectangleProperty.Id,info.BoundingRectangle}};
        object pattern;if(cached?element.TryGetCachedPattern(ValuePattern.Pattern,out pattern):element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))values[ValuePattern.ValueProperty.Id]=text;
        if(cached?element.TryGetCachedPattern(TogglePattern.Pattern,out pattern):element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))values[TogglePattern.ToggleStateProperty.Id]=cached?((TogglePattern)pattern).Cached.ToggleState:((TogglePattern)pattern).Current.ToggleState;
        if(cached?element.TryGetCachedPattern(SelectionItemPattern.Pattern,out pattern):element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))values[SelectionItemPattern.IsSelectedProperty.Id]=cached?((SelectionItemPattern)pattern).Cached.IsSelected:((SelectionItemPattern)pattern).Current.IsSelected;
        return values;
    }
    static CacheRequest TreeCache() {
        var cache=new CacheRequest {TreeScope=TreeScope.Element|TreeScope.Children,TreeFilter=Automation.ControlViewCondition,AutomationElementMode=AutomationElementMode.Full};
        foreach(var property in new AutomationProperty[]{AutomationElement.NameProperty,AutomationElement.AutomationIdProperty,AutomationElement.ClassNameProperty,AutomationElement.ControlTypeProperty,AutomationElement.IsEnabledProperty,AutomationElement.IsOffscreenProperty,AutomationElement.IsPasswordProperty,AutomationElement.IsKeyboardFocusableProperty,AutomationElement.HasKeyboardFocusProperty,AutomationElement.BoundingRectangleProperty,AutomationElement.NativeWindowHandleProperty,ValuePattern.ValueProperty,ValuePattern.IsReadOnlyProperty,TogglePattern.ToggleStateProperty,SelectionItemPattern.IsSelectedProperty})cache.Add(property);
        foreach(var pattern in new AutomationPattern[]{InvokePattern.Pattern,TogglePattern.Pattern,SelectionItemPattern.Pattern,ValuePattern.Pattern,TextPattern.Pattern,ScrollPattern.Pattern})cache.Add(pattern);
        return cache;
    }
    static object WaitFor(Dictionary<string,object> args) {
        int waitMs=Math.Max(200,Math.Min(10000,Num(args,"waitMs",2000)));string query=Str(args,"query"),condition=Str(args,"condition","window");
        if(condition!="window"&&query.Length==0)throw new Failure("QUERY_REQUIRED","条件等待需要 query");
        var started=DateTime.UtcNow;bool matched=false;object detail=null;int polls=0;
        do {
            Check();polls++;
            if(condition=="window"||condition=="active-window"){
                var inventory=(Dictionary<string,object>)Windows();
                foreach(Dictionary<string,object> window in (List<object>)inventory["windows"]){
                    if(args.ContainsKey("windowId")&&Convert.ToInt64(window["windowId"])!=Convert.ToInt64(args["windowId"]))continue;
                    if(query.Length>0&&!Convert.ToString(window["title"]).StartsWith(query,StringComparison.OrdinalIgnoreCase))continue;
                    if(query.Length==0)continue;
                    if(!Convert.ToBoolean(window["minimized"])&&(condition=="window"||Convert.ToBoolean(window["foreground"]))){matched=true;detail=window;break;}
                }
            } else if(condition=="element"||condition=="enabled"||condition=="focused"||condition=="text") {
                long hwnd=args.ContainsKey("windowId")?Convert.ToInt64(args["windowId"]):GetForegroundWindow().ToInt64();
                try{var observed=(Dictionary<string,object>)Observe(Obj("windowId",hwnd,"maxElements",400,"budgetMs",500));
                    foreach(Dictionary<string,object> item in (List<object>)observed["elements"]){
                        bool text=Convert.ToString(item["name"]).IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0||(condition=="text"&&!Convert.ToBoolean(item["password"])&&Convert.ToString(item["value"]).IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0);
                        if(!text||Convert.ToBoolean(item["offscreen"]))continue;
                        if(condition=="enabled"&&!Convert.ToBoolean(item["enabled"]))continue;
                        if(condition=="focused"&&!Convert.ToBoolean(item["focused"]))continue;
                        matched=true;detail=Obj("windowId",hwnd,"name",item["name"],"role",item["role"],"enabled",item["enabled"],"focused",item["focused"]);break;
                    }
                }catch(Failure failure){if(failure.Code=="CANCELLED")throw;}catch(Exception){}
            }else throw new Failure("INVALID_CONDITION","未知等待条件");
            if(matched)break;Thread.Sleep(100);
        }while((DateTime.UtcNow-started).TotalMilliseconds<waitMs);
        return Obj("matched",matched,"timedOut",!matched,"elapsedMs",(int)(DateTime.UtcNow-started).TotalMilliseconds,"query",query,"condition",condition,"polls",polls,"target",detail);
    }
    static object SaveCapture(Bitmap original,RECT source,Dictionary<string,object> args) {
        RECT capture=source;
        if(args.ContainsKey("region")&&args["region"]!=null){var region=args["region"] as Dictionary<string,object>;if(region==null)throw new Failure("INVALID_REGION","region 必须为对象");int x=Num(region,"x"),y=Num(region,"y"),w=Num(region,"width"),h=Num(region,"height");
            if(w<1||h<1||x<source.Left||y<source.Top||(long)x+w>source.Right||(long)y+h>source.Bottom)throw new Failure("INVALID_REGION","截图区域超出原观察范围，不自动裁剪或换区域");capture=new RECT {Left=x,Top=y,Right=x+w,Bottom=y+h};}
        int sw=capture.Right-capture.Left,sh=capture.Bottom-capture.Top;int maxWidth=Num(args,"maxWidth",sw);if(args.ContainsKey("maxWidth")&&(maxWidth<160||maxWidth>4096))throw new Failure("INVALID_ARGUMENT","maxWidth 范围为 160..4096");
        int width=Math.Min(sw,maxWidth),height=Math.Max(1,(int)Math.Round(sh*(double)width/sw));
        using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)){
            using(var graphics=Graphics.FromImage(bitmap)){graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;graphics.DrawImage(original,new Rectangle(0,0,width,height),new Rectangle(capture.Left-source.Left,capture.Top-source.Top,sw,sh),GraphicsUnit.Pixel);}
            using(var stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);return Obj("pngBase64",Convert.ToBase64String(stream.ToArray()),"width",width,"height",height,"captureRect",RectObject(capture),"imageTransform",Obj("originX",capture.Left,"originY",capture.Top,"scaleX",sw/(double)width,"scaleY",sh/(double)height,"imageWidth",width,"imageHeight",height,"units","absolute screen pixels"));}
        }
    }
    static List<List<POINT>> Paths(Dictionary<string,object> args) {
        var result=new List<List<POINT>>();object raw;
        if(args.ContainsKey("strokes"))raw=args["strokes"];else if(args.ContainsKey("path"))raw=new object[]{args["path"]};else throw new Failure("INVALID_PATH","没有路径");
        var strokes=raw as IEnumerable;if(strokes==null)throw new Failure("INVALID_PATH","strokes 为笔画列表");int points=0;
        foreach(object stroke in strokes){var list=stroke as IEnumerable;if(list==null)throw new Failure("INVALID_PATH","笔画为路径点列表");var path=new List<POINT>();foreach(object value in list){var point=value as Dictionary<string,object>;if(point==null||!point.ContainsKey("x")||!point.ContainsKey("y"))throw new Failure("INVALID_PATH","路径点为 x/y 对象");path.Add(new POINT {X=Num(point,"x"),Y=Num(point,"y")});}
            if(path.Count<2||path.Count>256)throw new Failure("INVALID_PATH","每个笔画需要 2..256 点");points+=path.Count;result.Add(path);}
        if(result.Count<1||result.Count>32||points>1024)throw new Failure("INVALID_PATH","路径超出数量上限");return result;
    }
    static object DrawPaths(Dictionary<string,object> args) {
        RequireLease();var cited=Cited(args);string mode=Str(args,"mode","mouse");if(mode!="mouse")throw new Failure("MOUSE_REQUIRED","路径操作只支持 mouse");
        Stamp target=cited;
        if(cited.Screen&&!cited.Targets.TryGetValue(Convert.ToInt64(args["windowId"]),out target))throw new Failure("TARGET_NOT_OBSERVED","目标必须来自观察");
        var paths=Paths(args);int duration=Math.Max(100,Math.Min(10000,Num(args,"durationMs",1000))),total=0;RECT bounds=target.Rect;
        if(args.ContainsKey("elementId")){if(cited.Screen)throw new Failure("WINDOW_OBSERVATION_REQUIRED","控件路径请 observe 具体窗口");var rect=Element(args,target).Current.BoundingRectangle;bounds=new RECT {Left=(int)rect.Left,Top=(int)rect.Top,Right=(int)rect.Right,Bottom=(int)rect.Bottom};}
        Func<POINT,INPUT> move=delegate(POINT point){if(point.X<bounds.Left||point.X>=bounds.Right||point.Y<bounds.Top||point.Y>=bounds.Bottom)throw new Failure("OUT_OF_WINDOW","路径超出已观察的绘制目标");if(args.ContainsKey("elementId")){Element(args,target);VerifyElementHit(target,args,point.X,point.Y);}return cited.Screen?ScreenMove(cited,target,point.X,point.Y):Move(target,point.X,point.Y);};
        foreach(var path in paths){total+=path.Count-1;foreach(var point in path){if(point.X<bounds.Left||point.X>=bounds.Right||point.Y<bounds.Top||point.Y>=bounds.Bottom)throw new Failure("OUT_OF_WINDOW","路径超出目标，未投递输入");if(GetAncestor(WindowFromPoint(point),2).ToInt64()!=target.Hwnd)throw new Failure("TARGET_OCCLUDED","路径被其他窗口遮挡，未投递输入");if(args.ContainsKey("elementId"))VerifyElementHit(target,args,point.X,point.Y);}}
        Busy();if(!cited.Screen&&!Shell(target))Foreground(target);string button=Str(args,"button","left");uint down=button=="left"?2u:button=="right"?8u:button=="middle"?32u:0u,up=button=="left"?4u:button=="right"?16u:64u;if(down==0)throw new Failure("INVALID_BUTTON","未知鼠标键");
        int completed=0,samples=0;var started=DateTime.UtcNow;
        foreach(var path in paths){var first=path[0];Input(new INPUT[]{move(first),Mouse(down)});POINT last=first;
            try{for(int i=1;i<path.Count;i++){var end=path[i];int intervals=Math.Max(1,Math.Min(Math.Max(1,1200/total),(int)Math.Ceiling(Math.Max(Math.Abs(end.X-last.X),Math.Abs(end.Y-last.Y))/4.0)));var origin=last;
                    for(int n=1;n<=intervals;n++){Check();POINT actual;GetCursorPos(out actual);if(Math.Abs(actual.X-last.X)>3||Math.Abs(actual.Y-last.Y)>3)throw new Failure("HUMAN_INPUT_BUSY","人工移动鼠标，已停止路径输入");last=new POINT {X=origin.X+(end.X-origin.X)*n/intervals,Y=origin.Y+(end.Y-origin.Y)*n/intervals};Input(new INPUT[]{move(last)});samples++;Thread.Sleep(Math.Max(1,duration/Math.Max(1,total)/intervals));}}
                completed++;
            }finally{Release(new INPUT[]{Mouse(up)});}
        }
        return Obj("performed",true,"mode","mouse","windowId",target.Hwnd,"completedStrokes",completed,"samples",samples,"elapsedMs",(int)(DateTime.UtcNow-started).TotalMilliseconds);
    }
}
}
