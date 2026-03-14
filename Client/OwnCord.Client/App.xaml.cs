using System.IO;
using System.Windows;
using OwnCord.Client.Services;
using OwnCord.Client.ViewModels;

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
    }
}

