param([Parameter(Mandatory=$true)][int]$OwnerProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
#pragma warning disable 0649
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class JotArchiveProcessJob
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    static void SetKillOnClose(IntPtr job, bool enabled)
    {
        var limits = new ExtendedLimits();
        limits.Basic.Flags = enabled ? 0x2000u : 0u;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    static void Reply(string value)
    {
        Console.Out.WriteLine(value);
        Console.Out.Flush();
    }

    public static int Run(int ownerProcessId)
    {
        IntPtr job = IntPtr.Zero, owner = IntPtr.Zero;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            SetKillOnClose(job, true);
            owner = OpenProcess(0x100101, false, ownerProcessId);
            if (owner == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

            // Capture the handle before the live owner authorizes attachment.
            Reply("ready");
            if (Console.In.ReadLine() != "attach") return 1;
            if (!AssignProcessToJobObject(job, owner)) throw new Win32Exception(Marshal.GetLastWin32Error());
            Reply("attached");

            if (Console.In.ReadLine() != "disarm") return 1;
            for (int attempt = 0; attempt < 20; attempt++)
            {
                Accounting accounting;
                if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (accounting.ActiveProcesses == 1 && WaitForSingleObject(owner, 0) == 258)
                {
                    SetKillOnClose(job, false);
                    Reply("released");
                    return 0;
                }
                Thread.Sleep(100);
            }
            return 1;
        }
        finally
        {
            if (owner != IntPtr.Zero) CloseHandle(owner);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@
try {
    exit ([JotArchiveProcessJob]::Run($OwnerProcessId))
} catch {
    [Console]::Error.WriteLine('archive_windows_job_failed')
    exit 1
}
