struct Notifier; impl Notifier { fn send_sms(&self, _:u32, text:&str)->Result<(),()> { self.send("1",text); Ok(()) } fn send(&self,_:&str,_:&str){} }
