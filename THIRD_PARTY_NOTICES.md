# Third-Party Notices

The native Windows capture path uses the following redistributed managed assemblies:

- **SharpDX 4.2.0** — `SharpDX.dll`
- **SharpDX.DXGI 4.2.0** — `SharpDX.DXGI.dll`
- **SharpDX.Direct3D11 4.2.0** — `SharpDX.Direct3D11.dll`

Project: <https://github.com/sharpdx/SharpDX>
License: MIT (<https://github.com/sharpdx/SharpDX/blob/master/LICENSE>)
NuGet copyright metadata: Copyright (c) 2010-2016 Alexandre Mutel.

## SharpDX MIT License

Copyright (c) 2010-2016 Alexandre Mutel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

The .NET 8 runtime and Windows SDK APIs are host/platform prerequisites, not
files redistributed by this package. Their presence must be checked by the
native worker startup and release diagnostics rather than implied by this
notice.
