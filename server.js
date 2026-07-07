const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// التحقق من وجود متغير قاعدة البيانات
if (!process.env.DATABASE_URL) {
    console.error('❌ متغير DATABASE_URL غير موجود. تأكد من إضافته في Railway Variables.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) {
        console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
        process.exit(1);
    } else {
        console.log('✅ تم الاتصال بقاعدة البيانات بنجاح');
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------- إنشاء الجداول وإضافة الأعمدة المفقودة -------------------
const initDB = async () => {
    try {
        // 1. إنشاء جدول products إذا لم يكن موجوداً
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                sale_price INTEGER NOT NULL,
                cost_price INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. التحقق من وجود عمود sort_order وإضافته إذا كان مفقوداً (للقواعد القديمة)
        const checkColumn = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='products' AND column_name='sort_order'
        `);
        if (checkColumn.rowCount === 0) {
            console.log('⚠️ عمود sort_order غير موجود، جاري إضافته...');
            await pool.query('ALTER TABLE products ADD COLUMN sort_order INTEGER DEFAULT 0;');
            console.log('✅ تم إضافة عمود sort_order');
        }

        // 3. إنشاء باقي الجداول
        await pool.query(`
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
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS daily_reports (
                id SERIAL PRIMARY KEY,
                report_date DATE UNIQUE NOT NULL,
                total_revenue INTEGER DEFAULT 0,
                total_cost INTEGER DEFAULT 0,
                total_profit INTEGER DEFAULT 0,
                total_orders INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ جميع الجداول جاهزة');
    } catch (err) {
        console.error('❌ خطأ في إنشاء الجداول:', err.message);
        process.exit(1);
    }
};
initDB();

// ------------------- واجهات API -------------------

// جلب المنتجات (مرتبة حسب sort_order)
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY sort_order ASC, id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('خطأ في /api/products:', err.message);
        res.status(500).json({ error: 'حدث خطأ في جلب المنتجات' });
    }
});

// إضافة منتج جديد (يحصل على أعلى sort_order)
app.post('/api/products', async (req, res) => {
    const { name, salePrice, costPrice } = req.body;
    
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'اسم المنتج مطلوب' });
    }
    if (salePrice === undefined || isNaN(parseInt(salePrice)) || parseInt(salePrice) < 0) {
        return res.status(400).json({ error: 'سعر البيع يجب أن يكون رقم موجب' });
    }
    if (costPrice === undefined || isNaN(parseInt(costPrice)) || parseInt(costPrice) < 0) {
        return res.status(400).json({ error: 'التكلفة يجب أن تكون رقم موجب' });
    }
    if (parseInt(salePrice) <= parseInt(costPrice)) {
        return res.status(400).json({ error: 'سعر البيع يجب أن يكون أكبر من التكلفة' });
    }

    try {
        const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order), 0) as max FROM products');
        const newOrder = parseInt(maxOrder.rows[0].max) + 1;

        const result = await pool.query(
            'INSERT INTO products (name, sale_price, cost_price, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
            [name.trim(), parseInt(salePrice), parseInt(costPrice), newOrder]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('خطأ في POST /api/products:', err.message);
        res.status(500).json({ error: 'فشل في إضافة المنتج' });
    }
});

// تعديل منتج
app.put('/api/products/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { name, salePrice, costPrice } = req.body;

    if (isNaN(id)) {
        return res.status(400).json({ error: 'معرف المنتج غير صحيح' });
    }
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'اسم المنتج مطلوب' });
    }
    if (salePrice === undefined || isNaN(parseInt(salePrice)) || parseInt(salePrice) < 0) {
        return res.status(400).json({ error: 'سعر البيع يجب أن يكون رقم موجب' });
    }
    if (costPrice === undefined || isNaN(parseInt(costPrice)) || parseInt(costPrice) < 0) {
        return res.status(400).json({ error: 'التكلفة يجب أن تكون رقم موجب' });
    }
    if (parseInt(salePrice) <= parseInt(costPrice)) {
        return res.status(400).json({ error: 'سعر البيع يجب أن يكون أكبر من التكلفة' });
    }

    try {
        const result = await pool.query(
            'UPDATE products SET name = $1, sale_price = $2, cost_price = $3 WHERE id = $4 RETURNING *',
            [name.trim(), parseInt(salePrice), parseInt(costPrice), id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'المنتج غير موجود' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('خطأ في PUT /api/products/:id:', err.message);
        res.status(500).json({ error: 'فشل في تعديل المنتج' });
    }
});

// إعادة ترتيب المنتجات
app.post('/api/products/reorder', async (req, res) => {
    const { orderedIds } = req.body;
    if (!orderedIds || !Array.isArray(orderedIds) || orderedIds.length === 0) {
        return res.status(400).json({ error: 'بيانات غير صالحة' });
    }

    try {
        await pool.query('BEGIN');
        for (let i = 0; i < orderedIds.length; i++) {
            const id = parseInt(orderedIds[i]);
            if (isNaN(id)) continue;
            await pool.query('UPDATE products SET sort_order = $1 WHERE id = $2', [i + 1, id]);
        }
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('خطأ في POST /api/products/reorder:', err.message);
        res.status(500).json({ error: 'فشل في إعادة ترتيب المنتجات' });
    }
});

// حذف منتج
app.delete('/api/products/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
        return res.status(400).json({ error: 'معرف المنتج غير صحيح' });
    }
    try {
        const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'المنتج غير موجود' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('خطأ في DELETE /api/products/:id:', err.message);
        res.status(500).json({ error: 'فشل في حذف المنتج' });
    }
});

// تسجيل مبيعة جديدة
app.post('/api/sales', async (req, res) => {
    const { productId, productName, salePrice, costPrice, profit, date, time } = req.body;
    if (!productId || !productName || salePrice == null || costPrice == null || profit == null || !date || !time) {
        return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
    if (!timeRegex.test(time)) {
        return res.status(400).json({ error: 'صيغة الوقت غير صحيحة، يجب أن تكون HH:MM:SS' });
    }
    try {
        const productCheck = await pool.query('SELECT id FROM products WHERE id = $1', [parseInt(productId)]);
        if (productCheck.rowCount === 0) {
            return res.status(404).json({ error: 'المنتج غير موجود في قاعدة البيانات' });
        }
        const result = await pool.query(
            `INSERT INTO sales (product_id, product_name, sale_price, cost_price, profit, sale_date, sale_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [parseInt(productId), productName, parseInt(salePrice), parseInt(costPrice), parseInt(profit), date, time]
        );
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error('خطأ في POST /api/sales:', err.message);
        res.status(500).json({ error: 'فشل في تسجيل المبيعة: ' + err.message });
    }
});

// حذف مبيعة
app.delete('/api/sales/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'معرف المبيعة غير صحيح' });
    try {
        const result = await pool.query('DELETE FROM sales WHERE id = $1 RETURNING id', [id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'المبيعة غير موجودة' });
        res.json({ success: true });
    } catch (err) {
        console.error('خطأ في DELETE /api/sales/:id:', err.message);
        res.status(500).json({ error: 'فشل في حذف المبيعة' });
    }
});

// جلب المبيعات حسب التاريخ
app.get('/api/sales', async (req, res) => {
    const { date, startDate, endDate } = req.query;
    let query = 'SELECT * FROM sales';
    const params = [];
    const conditions = [];
    if (date) { conditions.push(`sale_date = $${params.length + 1}`); params.push(date); }
    if (startDate && endDate) { conditions.push(`sale_date BETWEEN $${params.length + 1} AND $${params.length + 2}`); params.push(startDate, endDate); }
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY timestamp DESC';
    try {
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('خطأ في /api/sales:', err.message);
        res.status(500).json({ error: 'فشل في جلب المبيعات' });
    }
});

// إحصائيات اليوم (مع إجمالي التكلفة)
app.get('/api/stats/today', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const result = await pool.query(
            `SELECT 
                COALESCE(SUM(sale_price), 0) as revenue,
                COALESCE(SUM(cost_price), 0) as total_cost,
                COALESCE(SUM(profit), 0) as profit,
                COUNT(*) as orders
             FROM sales WHERE sale_date = $1`,
            [today]
        );
        res.json({
            revenue: parseInt(result.rows[0].revenue),
            totalCost: parseInt(result.rows[0].total_cost),
            profit: parseInt(result.rows[0].profit),
            orders: parseInt(result.rows[0].orders)
        });
    } catch (err) {
        console.error('خطأ في /api/stats/today:', err.message);
        res.status(500).json({ error: 'فشل في جلب إحصائيات اليوم' });
    }
});

// إحصائيات عامة
app.get('/api/stats/general', async (req, res) => {
    try {
        const totals = await pool.query(`SELECT COALESCE(SUM(sale_price), 0) as total_revenue, COALESCE(SUM(profit), 0) as total_profit, COUNT(*) as total_sales FROM sales`);
        const days = await pool.query(`SELECT COUNT(DISTINCT sale_date) as total_days FROM sales`);
        const totalDays = parseInt(days.rows[0].total_days) || 0;
        const totalRevenue = parseInt(totals.rows[0].total_revenue);
        const avgDaily = totalDays > 0 ? Math.round(totalRevenue / totalDays) : 0;
        res.json({
            totalRevenue: totalRevenue,
            totalProfit: parseInt(totals.rows[0].total_profit),
            totalDays: totalDays,
            avgDaily: avgDaily
        });
    } catch (err) {
        console.error('خطأ في /api/stats/general:', err.message);
        res.status(500).json({ error: 'فشل في جلب الإحصائيات العامة' });
    }
});

// ------------------- مهمة منتصف الليل (بتوقيت العراق) -------------------
// الساعة 21:00 بتوقيت UTC = 12:00 منتصف الليل بتوقيت بغداد (UTC+3)
cron.schedule('0 21 * * *', async () => {
    const todayStr = new Date().toISOString().split('T')[0];
    console.log(`⏰ جاري حفظ ملخص اليوم ${todayStr}...`);
    try {
        const stats = await pool.query(
            `SELECT 
                COALESCE(SUM(sale_price), 0) as revenue,
                COALESCE(SUM(cost_price), 0) as total_cost,
                COALESCE(SUM(profit), 0) as profit,
                COUNT(*) as orders
             FROM sales WHERE sale_date = $1`,
            [todayStr]
        );
        const { revenue, total_cost, profit, orders } = stats.rows[0];
        await pool.query(
            `INSERT INTO daily_reports (report_date, total_revenue, total_cost, total_profit, total_orders)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (report_date) DO UPDATE SET
             total_revenue = EXCLUDED.total_revenue,
             total_cost = EXCLUDED.total_cost,
             total_profit = EXCLUDED.total_profit,
             total_orders = EXCLUDED.total_orders`,
            [todayStr, parseInt(revenue), parseInt(total_cost), parseInt(profit), parseInt(orders)]
        );
        console.log(`✅ تم حفظ تقرير ${todayStr}: إيرادات ${parseInt(revenue)}, تكلفة ${parseInt(total_cost)}, أرباح ${parseInt(profit)}, عدد ${parseInt(orders)}`);
    } catch (err) {
        console.error('❌ خطأ في المهمة المجدولة:', err.message);
    }
});

// تقديم الواجهة الأمامية
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// بدء الخادم
app.listen(port, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ ${port}`);
});
