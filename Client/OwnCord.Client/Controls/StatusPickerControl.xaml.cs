using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace OwnCord.Client.Controls;

public partial class StatusPickerControl : UserControl
{
    public static readonly DependencyProperty SelectedStatusProperty =
        DependencyProperty.Register(
            nameof(SelectedStatus),
            typeof(string),
            typeof(StatusPickerControl),
            new PropertyMetadata("online"));

    public static readonly DependencyProperty StatusChangedCommandProperty =
        DependencyProperty.Register(
            nameof(StatusChangedCommand),
            typeof(ICommand),
            typeof(StatusPickerControl),
            new PropertyMetadata(null));

    public StatusPickerControl()
    {
        InitializeComponent();
    }

    public string SelectedStatus
    {
        get => (string)GetValue(SelectedStatusProperty);
        set => SetValue(SelectedStatusProperty, value);
    }

    public ICommand StatusChangedCommand
    {
        get => (ICommand)GetValue(StatusChangedCommandProperty);
        set => SetValue(StatusChangedCommandProperty, value);
    }
}
