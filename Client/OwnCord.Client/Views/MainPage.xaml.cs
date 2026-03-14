using System.Windows.Controls;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Views;

public partial class MainPage : Page
{
    public MainPage(MainViewModel vm)
    {
        InitializeComponent();
        DataContext = vm;
    }
}
