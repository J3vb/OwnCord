using System.IO;
using System.Threading.Tasks;
using System.Windows;
using OwnCord.Client.Services;
using OwnCord.Client.ViewModels;
using OwnCord.Client.Views;

namespace OwnCord.Client;

public partial class App : Application
{
    private void Application_Startup(object sender, StartupEventArgs e)
    {
        var dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "OwnCord");

        var profileService = new ProfileService(dataDir);
        var credentialService = new CredentialService();
        var wsService = new WebSocketService();

        var connectVm = new ConnectViewModel(profileService);
        var mainVm = new MainViewModel();

        var mainWindow = new MainWindow(connectVm, mainVm, credentialService, wsService);
        mainWindow.Show();

        // Clean up old binary from previous update
        var updateService = new UpdateService();
        updateService.CleanupOldVersion();

        // Check for updates (non-blocking)
        _ = Task.Run(async () =>
        {
            var info = await updateService.CheckForUpdateAsync();
            if (info?.UpdateAvailable == true)
            {
                await Current.Dispatcher.InvokeAsync(() =>
                {
                    var vm = new UpdateViewModel(updateService, info);
                    var dialog = new UpdateDialog(vm);
                    dialog.ShowDialog();
                });
            }
        });
    }
}

