param([long]$WindowHandle, [string]$PointsJson)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RegionProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr window, IntPtr region);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region, int x, int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr value);
}
'@
[void][RegionProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$targetWindow = [IntPtr]::new($WindowHandle)
$scale = [RegionProbe]::GetDpiForWindow($targetWindow) / 96.0
$rect = [RegionProbe+Rect]::new()
[void][RegionProbe]::GetWindowRect($targetWindow, [ref]$rect)
$region = [RegionProbe]::CreateRectRgn(0, 0, 0, 0)
try {
  $kind = [RegionProbe]::GetWindowRgn($targetWindow, $region)
  $points = @(foreach ($point in (ConvertFrom-Json $PointsJson)) {
    $x = [int][Math]::Round($point.x * $scale)
    $y = [int][Math]::Round($point.y * $scale)
    $screenPoint = [RegionProbe+Point]::new()
    $screenPoint.X = $rect.Left + $x; $screenPoint.Y = $rect.Top + $y
    $hitWindow = [RegionProbe]::WindowFromPoint($screenPoint)
    [pscustomobject]@{
      name = $point.name
      included = [RegionProbe]::PtInRegion($region, $x, $y)
      hitsPet = ([RegionProbe]::GetAncestor($hitWindow, 2) -eq $targetWindow)
    }
  })
  [pscustomobject]@{ kind = $kind; scale = $scale; points = $points } | ConvertTo-Json -Compress -Depth 4
} finally { [void][RegionProbe]::DeleteObject($region) }
