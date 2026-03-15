using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace OwnCord.Client.Controls;

public partial class ReplyComposeBar : UserControl
{
    public static readonly DependencyProperty UsernameProperty =
        DependencyProperty.Register(
            nameof(Username),
            typeof(string),
            typeof(ReplyComposeBar),
            new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty CancelCommandProperty =
        DependencyProperty.Register(
            nameof(CancelCommand),
            typeof(ICommand),
            typeof(ReplyComposeBar),
            new PropertyMetadata(null));

    public string Username
    {
        get => (string)GetValue(UsernameProperty);
        set => SetValue(UsernameProperty, value);
    }

    public ICommand? CancelCommand
    {
        get => (ICommand?)GetValue(CancelCommandProperty);
        set => SetValue(CancelCommandProperty, value);
    }

    public ReplyComposeBar()
    {
        InitializeComponent();
    }
}
