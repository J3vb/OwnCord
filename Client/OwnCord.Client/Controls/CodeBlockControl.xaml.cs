using System.Windows;
using System.Windows.Controls;

namespace OwnCord.Client.Controls;

public partial class CodeBlockControl : UserControl
{
    public static readonly DependencyProperty CodeProperty =
        DependencyProperty.Register(
            nameof(Code),
            typeof(string),
            typeof(CodeBlockControl),
            new PropertyMetadata(string.Empty, OnPropertyChanged));

    public static readonly DependencyProperty CodeLanguageProperty =
        DependencyProperty.Register(
            nameof(CodeLanguage),
            typeof(string),
            typeof(CodeBlockControl),
            new PropertyMetadata(string.Empty, OnPropertyChanged));

    public string Code
    {
        get => (string)GetValue(CodeProperty);
        set => SetValue(CodeProperty, value);
    }

    public string CodeLanguage
    {
        get => (string)GetValue(CodeLanguageProperty);
        set => SetValue(CodeLanguageProperty, value);
    }

    public CodeBlockControl()
    {
        InitializeComponent();
    }

    private static void OnPropertyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is CodeBlockControl control)
        {
            control.UpdateDisplay();
        }
    }

    private void UpdateDisplay()
    {
        CodeText.Text = Code;

        var hasLanguage = !string.IsNullOrWhiteSpace(CodeLanguage);
        LanguageLabel.Text = hasLanguage ? CodeLanguage : string.Empty;
        LanguageLabel.Visibility = hasLanguage ? Visibility.Visible : Visibility.Collapsed;
    }
}
