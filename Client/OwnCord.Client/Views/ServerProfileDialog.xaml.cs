using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using OwnCord.Client.Models;

namespace OwnCord.Client.Views;

public partial class ServerProfileDialog : Window
{
    private readonly ServerProfile? _existing;
    private string _selectedColor = "#5865f2";
    private readonly Border[] _colorBorders;

    /// <summary>The resulting profile after Save, or null if cancelled.</summary>
    public ServerProfile? ResultProfile { get; private set; }

    /// <summary>True when a new profile was created, false when an existing one was edited.</summary>
    public bool IsNewProfile => _existing is null;

    public ServerProfileDialog(ServerProfile? existing = null)
    {
        InitializeComponent();
        _existing = existing;
        _colorBorders = [Color1, Color2, Color3, Color4, Color5, Color6];

        if (existing is not null)
        {
            TitleText.Text = "Edit Server";
            NameBox.Text = existing.Name;
            HostBox.Text = existing.Host;
            PortBox.Text = existing.Port.ToString();
            AutoConnectBox.IsChecked = existing.AutoConnect;
            _selectedColor = existing.Color;
        }

        UpdateColorSelection();
    }

    private void UpdateColorSelection()
    {
        foreach (var border in _colorBorders)
        {
            var tag = border.Tag as string ?? "";
            border.BorderBrush = string.Equals(tag, _selectedColor, StringComparison.OrdinalIgnoreCase)
                ? System.Windows.Media.Brushes.White
                : System.Windows.Media.Brushes.Transparent;
        }
    }

    private void ColorPick_Click(object sender, MouseButtonEventArgs e)
    {
        if (sender is Border border && border.Tag is string color)
        {
            _selectedColor = color;
            UpdateColorSelection();
        }
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        var name = NameBox.Text.Trim();
        var host = HostBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(host))
            return;

        if (!int.TryParse(PortBox.Text.Trim(), out var port) || port < 1 || port > 65535)
            port = 8443;

        var autoConnect = AutoConnectBox.IsChecked == true;

        ResultProfile = _existing is not null
            ? _existing with { Name = name, Host = host, Port = port, Color = _selectedColor, AutoConnect = autoConnect }
            : ServerProfile.Create(name, host, port: port, color: _selectedColor, autoConnect: autoConnect);

        DialogResult = true;
        Close();
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void TitleBar_MouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton == MouseButton.Left)
            DragMove();
    }
}
