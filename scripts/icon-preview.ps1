# 图标预览渲染器：把 Lucide 风格的 SVG path 画成 PNG，方便肉眼比对。
#
# 只支持我写图标会用到的那几个命令：M/L/C/H/V/Z（绝对坐标）。
# 手写扫描器（不用 Regex）是为了少引入程序集 —— PowerShell 7 里
# System.Drawing 本来就要显式引用，少一个依赖少一处坑。
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Out = "$env:TEMP\icon-preview.png",
  [double]$Scale = 14,
  [double]$Stroke = 2,
  [string]$Color = '#1c1c1e'
)

# PowerShell 7 / .NET 10 上 System.Drawing 被拆成了多个程序集
# （System.Private.Windows.GdiPlus 之类），单独指定一定会漏。
# 直接把当前已加载程序集的全路径都当引用传进去，最省事也最稳。
$refs = @(
  [System.AppDomain]::CurrentDomain.GetAssemblies() |
    ForEach-Object { $_.Location } |
    Where-Object { $_ -and (Test-Path $_) } |
    Sort-Object -Unique
)
$refs += [System.Drawing.Bitmap].Assembly.Location
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;

public static class SvgStroke {
    class Tok {
        readonly string s; int i;
        public Tok(string s) { this.s = s; i = 0; }
        void Skip() { while (i < s.Length && (char.IsWhiteSpace(s[i]) || s[i] == ',')) i++; }
        public bool Done { get { Skip(); return i >= s.Length; } }
        public bool HasCmd { get { Skip(); return i < s.Length && char.IsLetter(s[i]); } }
        public char NextCmd() { Skip(); return s[i++]; }
        void Num(out float v) {
            Skip(); int start = i;
            if (i < s.Length && (s[i] == '-' || s[i] == '+')) i++;
            while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '.')) i++;
            v = float.Parse(s.Substring(start, i - start), CultureInfo.InvariantCulture);
        }
        public float[] Nums(int n) {
            var a = new float[n];
            for (int k = 0; k < n; k++) Num(out a[k]);
            return a;
        }
    }

    public static GraphicsPath Build(string d) {
        var gp = new GraphicsPath();
        var t = new Tok(d);
        char cmd = '\0';
        float x = 0, y = 0, sx = 0, sy = 0;
        while (!t.Done) {
            if (t.HasCmd) cmd = t.NextCmd();
            char c = char.ToUpperInvariant(cmd);
            bool rel = char.IsLower(cmd);
            switch (c) {
                case 'M': {
                    var v = t.Nums(2);
                    x = rel ? x + v[0] : v[0]; y = rel ? y + v[1] : v[1];
                    sx = x; sy = y;
                    gp.StartFigure();
                    cmd = rel ? 'l' : 'L';   // SVG 规则：M 之后的多余坐标按 L 处理
                    break;
                }
                case 'L': {
                    var v = t.Nums(2);
                    float nx = rel ? x + v[0] : v[0], ny = rel ? y + v[1] : v[1];
                    gp.AddLine(x, y, nx, ny); x = nx; y = ny;
                    break;
                }
                case 'H': { var v = t.Nums(1); float nx = rel ? x + v[0] : v[0]; gp.AddLine(x, y, nx, y); x = nx; break; }
                case 'V': { var v = t.Nums(1); float ny = rel ? y + v[0] : v[0]; gp.AddLine(x, y, x, ny); y = ny; break; }
                case 'C': {
                    var v = t.Nums(6);
                    float c1x = v[0], c1y = v[1], c2x = v[2], c2y = v[3], ex = v[4], ey = v[5];
                    if (rel) { c1x += x; c1y += y; c2x += x; c2y += y; ex += x; ey += y; }
                    gp.AddBezier(x, y, c1x, c1y, c2x, c2y, ex, ey);
                    x = ex; y = ey;
                    break;
                }
                case 'Z': gp.CloseFigure(); x = sx; y = sy; break;
                default: throw new Exception("不支持的路径命令: " + cmd);
            }
        }
        return gp;
    }

    public static void Render(string[] paths, string outPath, float scale, float stroke, int size, int cr, int cg, int cb) {
        using (var bmp = new Bitmap((int)(size * scale), (int)(size * scale), PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp)) {
            g.Clear(Color.White);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            foreach (var d in paths) {
                if (string.IsNullOrWhiteSpace(d)) continue;
                using (var gp = Build(d))
                using (var pen = new Pen(Color.FromArgb(cr, cg, cb), (float)stroke * scale)) {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    var m = new Matrix();
                    m.Scale(scale, scale);
                    using (var scaled = gp.Clone() as GraphicsPath) {
                        scaled.Transform(m);
                        g.DrawPath(pen, scaled);
                    }
                }
            }
            bmp.Save(outPath, ImageFormat.Png);
        }
    }
}
'@ -ReferencedAssemblies $refs -ErrorAction Stop

$paths = $Path -split '\|'
$c = [System.Drawing.ColorTranslator]::FromHtml($Color)
[SvgStroke]::Render($paths, $Out, $Scale, $Stroke, 24, $c.R, $c.G, $c.B)
Write-Output "已渲染: $Out"
