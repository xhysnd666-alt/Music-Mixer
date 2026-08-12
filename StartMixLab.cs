using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;

class MixLabLauncher
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string py = Path.Combine(root, ".venv", "Scripts", "python.exe");
        const int port = 8000;
        string url = "http://127.0.0.1:" + port;

        if (!File.Exists(py))
        {
            MessageBoxW(IntPtr.Zero,
                "找不到运行环境：\n" + py + "\n\n请确认项目文件夹完整（.venv 目录存在）。",
                "MixLab 启动失败", 0x10);
            return;
        }

        if (PortOpen(port))
        {
            OpenBrowser(url);
            return;
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = py;
        psi.Arguments = "-m uvicorn backend.app:app --host 127.0.0.1 --port " + port;
        psi.WorkingDirectory = root;
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;

        Process proc = null;
        try { proc = Process.Start(psi); }
        catch (Exception ex)
        {
            MessageBoxW(IntPtr.Zero, "无法启动服务进程：\n" + ex.Message,
                "MixLab 启动失败", 0x10);
            return;
        }

        bool ok = false;
        for (int i = 0; i < 80; i++)
        {
            if (PortOpen(port)) { ok = true; break; }
            try { if (proc.HasExited) break; } catch { break; }
            Thread.Sleep(500);
        }

        if (!ok)
        {
            MessageBoxW(IntPtr.Zero,
                "服务启动失败。\n\n请运行项目文件夹里的「诊断工具.bat」，把窗口内容截图发给开发者。",
                "MixLab 启动失败", 0x10);
            return;
        }

        OpenBrowser(url);
        try { proc.WaitForExit(); } catch { }
    }

    static bool PortOpen(int port)
    {
        try
        {
            TcpClient c = new TcpClient();
            IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(500)) { c.Close(); return false; }
            c.EndConnect(ar);
            c.Close();
            return true;
        }
        catch { return false; }
    }

    static void OpenBrowser(string url)
    {
        try { Process.Start(url); } catch { }
    }
}
