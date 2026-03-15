using System.Collections;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace OwnCord.Client.Controls;

public partial class DmSidebarControl : UserControl
{
    public static readonly DependencyProperty DirectMessagesProperty =
        DependencyProperty.Register(
            nameof(DirectMessages),
            typeof(IEnumerable),
            typeof(DmSidebarControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty SelectedDmProperty =
        DependencyProperty.Register(
            nameof(SelectedDm),
            typeof(object),
            typeof(DmSidebarControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty SelectDmCommandProperty =
        DependencyProperty.Register(
            nameof(SelectDmCommand),
            typeof(ICommand),
            typeof(DmSidebarControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty FriendsCommandProperty =
        DependencyProperty.Register(
            nameof(FriendsCommand),
            typeof(ICommand),
            typeof(DmSidebarControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty CloseDmCommandProperty =
        DependencyProperty.Register(
            nameof(CloseDmCommand),
            typeof(ICommand),
            typeof(DmSidebarControl),
            new PropertyMetadata(null));

    public DmSidebarControl()
    {
        InitializeComponent();
    }

    public IEnumerable? DirectMessages
    {
        get => (IEnumerable?)GetValue(DirectMessagesProperty);
        set => SetValue(DirectMessagesProperty, value);
    }

    public object? SelectedDm
    {
        get => GetValue(SelectedDmProperty);
        set => SetValue(SelectedDmProperty, value);
    }

    public ICommand? SelectDmCommand
    {
        get => (ICommand?)GetValue(SelectDmCommandProperty);
        set => SetValue(SelectDmCommandProperty, value);
    }

    public ICommand? FriendsCommand
    {
        get => (ICommand?)GetValue(FriendsCommandProperty);
        set => SetValue(FriendsCommandProperty, value);
    }

    public ICommand? CloseDmCommand
    {
        get => (ICommand?)GetValue(CloseDmCommandProperty);
        set => SetValue(CloseDmCommandProperty, value);
    }
}
