using System.Windows.Forms;

namespace PiPocket
{
    sealed partial class TrayApp
    {
        bool confirmingRunnerQuit;

        bool ConfirmRunnerQuit()
        {
            object runner = ShellWire.Get(snapshot, "runner");
            if (!ShellWire.Flag(runner, "running")) { return true; }
            if (confirmingRunnerQuit) { return false; }

            string activity = ShellWire.Flag(runner, "working") ? "The runner is working now. " : "";
            confirmingRunnerQuit = true;
            try
            {
                return MessageBox.Show(Form.ActiveForm,
                    activity + "Quitting can interrupt runner commands. Runner background tasks stop even when the runner is idle.",
                    "Quit Pi Pocket?", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning,
                    MessageBoxDefaultButton.Button2) == DialogResult.OK;
            }
            finally { confirmingRunnerQuit = false; }
        }
    }
}
