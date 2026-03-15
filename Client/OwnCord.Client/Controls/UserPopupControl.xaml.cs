using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace OwnCord.Client.Controls;

public partial class UserPopupControl : UserControl
{
    public static readonly DependencyProperty UsernameProperty =
        DependencyProperty.Register(nameof(Username), typeof(string), typeof(UserPopupControl),
            new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty AvatarColorProperty =
        DependencyProperty.Register(nameof(AvatarColor), typeof(string), typeof(UserPopupControl),
            new PropertyMetadata("#5865f2"));

    public static readonly DependencyProperty RoleNameProperty =
        DependencyProperty.Register(nameof(RoleName), typeof(string), typeof(UserPopupControl),
            new PropertyMetadata("Member"));

    public static readonly DependencyProperty RoleColorProperty =
        DependencyProperty.Register(nameof(RoleColor), typeof(string), typeof(UserPopupControl),
            new PropertyMetadata("#949ba4"));

    public static readonly DependencyProperty JoinedDateProperty =
        DependencyProperty.Register(nameof(JoinedDate), typeof(string), typeof(UserPopupControl),
            new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty StatusTextProperty =
        DependencyProperty.Register(nameof(StatusText), typeof(string), typeof(UserPopupControl),
            new PropertyMetadata("Offline"));

    public static readonly DependencyProperty MessageCommandProperty =
        DependencyProperty.Register(nameof(MessageCommand), typeof(ICommand), typeof(UserPopupControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty CloseCommandProperty =
        DependencyProperty.Register(nameof(CloseCommand), typeof(ICommand), typeof(UserPopupControl),
            new PropertyMetadata(null));

    public UserPopupControl()
    {
        InitializeComponent();
    }

    public string Username
    {
        get => (string)GetValue(UsernameProperty);
        set => SetValue(UsernameProperty, value);
    }

    public string AvatarColor
    {
        get => (string)GetValue(AvatarColorProperty);
        set => SetValue(AvatarColorProperty, value);
    }

    public string RoleName
    {
        get => (string)GetValue(RoleNameProperty);
        set => SetValue(RoleNameProperty, value);
    }

    public string RoleColor
    {
        get => (string)GetValue(RoleColorProperty);
        set => SetValue(RoleColorProperty, value);
    }

    public string JoinedDate
    {
        get => (string)GetValue(JoinedDateProperty);
        set => SetValue(JoinedDateProperty, value);
    }

    public string StatusText
    {
        get => (string)GetValue(StatusTextProperty);
        set => SetValue(StatusTextProperty, value);
    }

    public ICommand MessageCommand
    {
        get => (ICommand)GetValue(MessageCommandProperty);
        set => SetValue(MessageCommandProperty, value);
    }

    public ICommand CloseCommand
    {
        get => (ICommand)GetValue(CloseCommandProperty);
        set => SetValue(CloseCommandProperty, value);
    }
}
