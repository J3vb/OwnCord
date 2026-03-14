namespace OwnCord.Client.ViewModels;

public sealed class SettingsViewModel : ViewModelBase
{
    private bool _isDarkTheme;
    private bool _mentionsOnly;
    private string _pushToTalkKey = "F4";

    public bool IsDarkTheme
    {
        get => _isDarkTheme;
        set => SetField(ref _isDarkTheme, value);
    }

    public bool MentionsOnly
    {
        get => _mentionsOnly;
        set => SetField(ref _mentionsOnly, value);
    }

    public string PushToTalkKey
    {
        get => _pushToTalkKey;
        set => SetField(ref _pushToTalkKey, value);
    }
}
