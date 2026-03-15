using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace OwnCord.Client.Controls;

public partial class ToastControl : UserControl
{
    private DispatcherTimer? _autoDismissTimer;

    public static readonly DependencyProperty MessageProperty =
        DependencyProperty.Register(
            nameof(Message),
            typeof(string),
            typeof(ToastControl),
            new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty IsOpenProperty =
        DependencyProperty.Register(
            nameof(IsOpen),
            typeof(bool),
            typeof(ToastControl),
            new FrameworkPropertyMetadata(false, FrameworkPropertyMetadataOptions.BindsTwoWayByDefault, OnIsOpenChanged));

    public ToastControl()
    {
        InitializeComponent();
    }

    public string Message
    {
        get => (string)GetValue(MessageProperty);
        set => SetValue(MessageProperty, value);
    }

    public bool IsOpen
    {
        get => (bool)GetValue(IsOpenProperty);
        set => SetValue(IsOpenProperty, value);
    }

    private static void OnIsOpenChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is ToastControl control)
            control.HandleIsOpenChanged((bool)e.NewValue);
    }

    private void HandleIsOpenChanged(bool isOpen)
    {
        _autoDismissTimer?.Stop();
        _autoDismissTimer = null;

        if (isOpen)
        {
            // Fade in
            var fadeIn = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(200))
            {
                EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut }
            };
            BeginAnimation(OpacityProperty, fadeIn);

            // Auto-dismiss after 3 seconds
            _autoDismissTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            _autoDismissTimer.Tick += OnAutoDismiss;
            _autoDismissTimer.Start();
        }
        else
        {
            // Fade out
            var fadeOut = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(300))
            {
                EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseIn }
            };
            BeginAnimation(OpacityProperty, fadeOut);
        }
    }

    private void OnAutoDismiss(object? sender, EventArgs e)
    {
        _autoDismissTimer?.Stop();
        _autoDismissTimer = null;
        IsOpen = false;
    }
}
