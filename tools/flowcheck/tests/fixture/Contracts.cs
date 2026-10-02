namespace Shop.Sms
{
    public interface ISmsClient { void Send(string phone, string text); }
    public interface ICustomerRepo { Customer Get(int id); }
    public class Customer { public string Phone { get; set; } public string Name { get; set; } }
}
