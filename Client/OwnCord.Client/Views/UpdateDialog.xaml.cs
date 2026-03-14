using System.Windows;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Views;

public partial class UpdateDialog : Window
{
    public UpdateDialog(UpdateViewModel viewModel)
    {
        InitializeComponent();
        DataContext = viewModel;
        viewModel.CloseRequested += () => Close();
    }
}
