using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class BootstrapInstaller
{
    [STAThread]
    private static int Main()
    {
        try
        {
            var baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            var installerScript = Path.Combine(baseDirectory, "install.cmd");

            if (!File.Exists(installerScript))
            {
                MessageBox.Show(
                    "No se ha encontrado install.cmd junto al instalador.",
                    "Fiber MDB Generator Installer",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = installerScript,
                WorkingDirectory = baseDirectory,
                UseShellExecute = true
            };

            using (var process = Process.Start(startInfo))
            {
                return process == null ? 1 : 0;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                ex.Message,
                "Fiber MDB Generator Installer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }
}
