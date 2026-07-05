const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// الاتصال بقاعدة البيانات (Railway يوفر DATABASE_URL تلقائياً)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// إنشاء الجداول تلقائياً عند التشغيل الأول
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                sale_price INTEGER NOT NULL,
                cost_price INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sales (
                id SERIAL PRIMARY KEY,
                product_id INTEGER REFERENCES products(id),
                product_name VARCHAR(255) NOT NULL,
                sale_price INTEGER NOT NULL,
                cost_price INTEGER NOT NULL,
                profit INTEGER NOT NULL,
                sale_date DATE NOT NULL,
                sale_time TIME NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS daily_reports (
                id SERIAL PRIMARY KEY,
                report_date DATE UNIQUE NOT NULL,
                total_revenue INTEGER DEFAULT 0,
                total_profit INTEGER DEFAULT 0,
                total_orders INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ قاعدة البيانات جاهزة');
    } catch (err) {
        console.error('❌ خطأ في قاعدة البيانات:', err);
    }
};
initDB();

// ------------------- واجهات API -------------------

// جلب جميع المنتجات
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// إضافة منتج جديد
app.post('/api/products', async (req, res) => {
    const { name, salePrice, costPrice } = req.body;
    if (!name || salePrice == null || costPrice == null) {
        return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO products (name, sale_price, cost_price) VALUES ($1, $2, $3) RETURNING *',
            [name, salePrice, costPrice]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// حذف منتج
app.delete('/api/products/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// تسجيل مبيعة جديدة
app.post('/api/sales', async (req, res) => {
    const { productId, productName, salePrice, costPrice, profit, date, time } = req.body;
    try {
        await pool.query(
            `INSERT INTO sales (product_id, product_name, sale_price, cost_price, profit, sale_date, sale_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [productId, productName, salePrice, costPrice, profit, date, time]
        );
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// جلب المبيعات حسب التاريخ (للتقارير)
app.get('/api/sales', async (req, res) => {
    const { date, startDate, endDate } = req.query;
    let query = 'SELECT * FROM sales';
    let params = [];
    let conditions = [];

    if (date) {
        conditions.push(`sale_date = $${params.length + 1}`);
        params.push(date);
    }
    if (startDate && endDate) {
        conditions.push(`sale_date BETWEEN $${params.length + 1} AND $${params.length + 2}`);
        params.push(startDate, endDate);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY timestamp DESC';

    try {
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// إحصائيات اليوم الحالي
app.get('/api/stats/today', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const result = await pool.query(
            `SELECT 
                COALESCE(SUM(sale_price), 0) as revenue,
                COALESCE(SUM(profit), 0) as profit,
                COUNT(*) as orders
             FROM sales WHERE sale_date = $1`,
            [today]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// إحصائيات عامة (كل المبيعات)
app.get('/api/stats/general', async (req, res) => {
    try {
        const totals = await pool.query(
            `SELECT 
                COALESCE(SUM(sale_price), 0) as total_revenue,
                COALESCE(SUM(profit), 0) as total_profit,
                COUNT(*) as total_sales
             FROM sales`
        );
        const days = await pool.query(
            `SELECT COUNT(DISTINCT sale_date) as total_days FROM sales`
        );
        const totalDays = parseInt(days.rows[0].total_days) || 0;
        const avgDaily = totalDays > 0 ? Math.round(totals.rows[0].total_revenue / totalDays) : 0;

        res.json({
            totalRevenue: totals.rows[0].total_revenue,
            totalProfit: totals.rows[0].total_profit,
            totalDays: totalDays,
            avgDaily: avgDaily
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------- مهمة منتصف الليل (الساعة 12 بالضبط بتوقيت العراق) -------------------
// توقيت العراق = UTC+3، لذلك الساعة 21 بتوقيت UTC = 12 منتصف الليل بتوقيت بغداد
cron.schedule('0 21 * * *', async () => {
    console.log('⏰ جاري حفظ ملخص اليوم في قاعدة البيانات...');
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    try {
        const stats = await pool.query(
            `SELECT 
                COALESCE(SUM(sale_price), 0) as revenue,
                COALESCE(SUM(profit), 0) as profit,
                COUNT(*) as orders
             FROM sales WHERE sale_date = $1`,
            [todayStr]
        );
        const { revenue, profit, orders } = stats.rows[0];
        
        await pool.query(
            `INSERT INTO daily_reports (report_date, total_revenue, total_profit, total_orders)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (report_date) DO UPDATE SET
             total_revenue = EXCLUDED.total_revenue,
             total_profit = EXCLUDED.total_profit,
             total_orders = EXCLUDED.total_orders`,
            [todayStr, revenue, profit, orders]
        );
        console.log(`✅ تم حفظ تقرير ${todayStr}: إيرادات ${revenue}, عدد ${orders}`);
    } catch (err) {
        console.error('❌ خطأ في المهمة المجدولة:', err);
    }
});

// تقديم الواجهة الأمامية
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`🚀 السيرفر شغال على المنفذ ${port}`);
});