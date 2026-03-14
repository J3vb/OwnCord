using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Input;
using OwnCord.Client.Services;

namespace OwnCord.Client.ViewModels;

public class UpdateViewModel : ViewModelBase
{
    private readonly IUpdateService _updateService;
    private readonly UpdateInfo _updateInfo;

    private bool _isDownloading;
    private string _statusText = "";

    public string CurrentVersion => _updateInfo.CurrentVersion;
    public string NewVersion => _updateInfo.LatestVersion;
    public string ReleaseNotes => _updateInfo.ReleaseNotes;

    public bool IsDownloading
    {
        get => _isDownloading;
        private set { _isDownloading = value; OnPropertyChanged(); }
    }

    public string StatusText
    {
        get => _statusText;
        private set { _statusText = value; OnPropertyChanged(); }
    }

    public ICommand UpdateNowCommand { get; }
    public ICommand SkipVersionCommand { get; }
    public ICommand RemindLaterCommand { get; }

    // Result: true = update started, false = skipped, null = remind later
    public bool? Result { get; private set; }

    public UpdateViewModel(IUpdateService updateService, UpdateInfo updateInfo)
    {
        _updateService = updateService;
        _updateInfo = updateInfo;

        UpdateNowCommand = new RelayCommand(
            () => _ = UpdateNowAsync(),
            () => !IsDownloading);
        SkipVersionCommand = new RelayCommand(
            SkipVersion,
            () => !IsDownloading);
        RemindLaterCommand = new RelayCommand(RemindLater);
    }

    private async Task UpdateNowAsync()
    {
        IsDownloading = true;
        StatusText = "Downloading update...";

        try
        {
            var tempPath = Path.GetTempFileName();
            await _updateService.DownloadAndVerifyAsync(
                _updateInfo.DownloadUrl, _updateInfo.ChecksumUrl, tempPath);

            StatusText = "Applying update...";
            _updateService.ApplyUpdate(tempPath);
            Result = true;
        }
        catch (Exception ex)
        {
            StatusText = $"Update failed: {ex.Message}";
            IsDownloading = false;
        }
    }

    private void SkipVersion()
    {
        _updateService.SkipVersion(_updateInfo.LatestVersion);
        Result = false;
        CloseRequested?.Invoke();
    }

    private void RemindLater()
    {
        Result = null;
        CloseRequested?.Invoke();
    }

    public event Action? CloseRequested;
}
