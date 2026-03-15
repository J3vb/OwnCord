using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace OwnCord.Client.Controls;

public partial class MessageActionsBar : UserControl
{
    public static readonly DependencyProperty ReplyCommandProperty =
        DependencyProperty.Register(
            nameof(ReplyCommand),
            typeof(ICommand),
            typeof(MessageActionsBar),
            new PropertyMetadata(null));

    public static readonly DependencyProperty EditCommandProperty =
        DependencyProperty.Register(
            nameof(EditCommand),
            typeof(ICommand),
            typeof(MessageActionsBar),
            new PropertyMetadata(null));

    public static readonly DependencyProperty DeleteCommandProperty =
        DependencyProperty.Register(
            nameof(DeleteCommand),
            typeof(ICommand),
            typeof(MessageActionsBar),
            new PropertyMetadata(null));

    public static readonly DependencyProperty IsOwnMessageProperty =
        DependencyProperty.Register(
            nameof(IsOwnMessage),
            typeof(bool),
            typeof(MessageActionsBar),
            new PropertyMetadata(false));

    public static readonly DependencyProperty CommandParameterProperty =
        DependencyProperty.Register(
            nameof(CommandParameter),
            typeof(object),
            typeof(MessageActionsBar),
            new PropertyMetadata(null));

    public ICommand? ReplyCommand
    {
        get => (ICommand?)GetValue(ReplyCommandProperty);
        set => SetValue(ReplyCommandProperty, value);
    }

    public ICommand? EditCommand
    {
        get => (ICommand?)GetValue(EditCommandProperty);
        set => SetValue(EditCommandProperty, value);
    }

    public ICommand? DeleteCommand
    {
        get => (ICommand?)GetValue(DeleteCommandProperty);
        set => SetValue(DeleteCommandProperty, value);
    }

    public bool IsOwnMessage
    {
        get => (bool)GetValue(IsOwnMessageProperty);
        set => SetValue(IsOwnMessageProperty, value);
    }

    public object? CommandParameter
    {
        get => GetValue(CommandParameterProperty);
        set => SetValue(CommandParameterProperty, value);
    }

    public MessageActionsBar()
    {
        InitializeComponent();
    }
}
