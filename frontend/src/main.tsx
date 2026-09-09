import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Shell } from "./components";
import { Account, Auth, Cart, Checkout, Home, Listing, OrderDetail, Orders, ProductDetail, RequireAuth, ReturnOrder } from "./pages";
import { ServiceApp } from "./service";
import { StoreProvider } from "./store";
import "./styles.css";

function App() {
  return <StoreProvider><BrowserRouter><Routes>
    <Route path="/service/*" element={<ServiceApp />} />
    <Route path="*" element={<Shell><Routes>
      <Route path="/" element={<Home />} />
      <Route path="/category/:slug" element={<Listing />} />
      <Route path="/search" element={<Listing />} />
      <Route path="/product/:id" element={<ProductDetail />} />
      <Route path="/cart" element={<Cart />} />
      <Route path="/signin" element={<Auth />} />
      <Route path="/register" element={<Auth register />} />
      <Route path="/checkout" element={<RequireAuth><Checkout /></RequireAuth>} />
      <Route path="/order/:id" element={<RequireAuth><OrderDetail confirmation /></RequireAuth>} />
      <Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />
      <Route path="/account/orders" element={<RequireAuth><Orders /></RequireAuth>} />
      <Route path="/account/orders/:id" element={<RequireAuth><OrderDetail /></RequireAuth>} />
      <Route path="/account/orders/:id/return" element={<RequireAuth><ReturnOrder /></RequireAuth>} />
      <Route path="*" element={<div className="empty"><h1>Page not found</h1><a href="/">Return home</a></div>} />
    </Routes></Shell>} />
  </Routes></BrowserRouter></StoreProvider>;
}

const root = document.getElementById("root");
if (root) ReactDOM.createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);

export default App;
