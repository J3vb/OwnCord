using System.Collections;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace OwnCord.Client.Controls;

public partial class FriendsViewControl : UserControl
{
    public static readonly DependencyProperty SelectedTabProperty =
        DependencyProperty.Register(
            nameof(SelectedTab),
            typeof(string),
            typeof(FriendsViewControl),
            new PropertyMetadata("online"));

    public static readonly DependencyProperty FriendsProperty =
        DependencyProperty.Register(
            nameof(Friends),
            typeof(IEnumerable),
            typeof(FriendsViewControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty FriendSearchTextProperty =
        DependencyProperty.Register(
            nameof(FriendSearchText),
            typeof(string),
            typeof(FriendsViewControl),
            new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty SelectTabCommandProperty =
        DependencyProperty.Register(
            nameof(SelectTabCommand),
            typeof(ICommand),
            typeof(FriendsViewControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty MessageFriendCommandProperty =
        DependencyProperty.Register(
            nameof(MessageFriendCommand),
            typeof(ICommand),
            typeof(FriendsViewControl),
            new PropertyMetadata(null));

    public FriendsViewControl()
    {
        InitializeComponent();
    }

    public string SelectedTab
    {
        get => (string)GetValue(SelectedTabProperty);
        set => SetValue(SelectedTabProperty, value);
    }

    public IEnumerable? Friends
    {
        get => (IEnumerable?)GetValue(FriendsProperty);
        set => SetValue(FriendsProperty, value);
    }

    public string FriendSearchText
    {
        get => (string)GetValue(FriendSearchTextProperty);
        set => SetValue(FriendSearchTextProperty, value);
    }

    public ICommand? SelectTabCommand
    {
        get => (ICommand?)GetValue(SelectTabCommandProperty);
        set => SetValue(SelectTabCommandProperty, value);
    }

    public ICommand? MessageFriendCommand
    {
        get => (ICommand?)GetValue(MessageFriendCommandProperty);
        set => SetValue(MessageFriendCommandProperty, value);
    }
}
