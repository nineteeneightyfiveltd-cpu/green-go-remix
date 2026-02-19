import { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ShoppingCart, Eye, Leaf, Droplets, Lock, AlertCircle, Cloud, Database, Zap, Moon, Brain, Smile, Heart, Sun, Wind, Minus, Plus, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useShop } from '@/context/ShopContext';
import { Product, DataSource } from '@/hooks/useProducts';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import { formatPrice } from '@/lib/currency';
import { PriceBreakdownTooltip } from './PriceBreakdownTooltip';
import { useIsMobile } from '@/hooks/use-mobile';

interface ProductCardProps {
  product: Product;
  onViewDetails: (product: Product) => void;
  showDataSource?: boolean;
}

// Effect-to-icon mapping for recognisable mood cues
const effectIconMap: Record<string, typeof Zap> = {
  energetic: Zap,
  energy: Zap,
  uplifted: Sun,
  uplifting: Sun,
  relaxed: Moon,
  relaxing: Moon,
  calm: Moon,
  focused: Brain,
  focus: Brain,
  creative: Brain,
  happy: Smile,
  euphoric: Smile,
  sleepy: Moon,
  sleep: Moon,
  tingly: Wind,
  aroused: Heart,
  hungry: Smile,
};

function getEffectIcon(effect: string) {
  const key = effect.toLowerCase().trim();
  return effectIconMap[key] || Leaf;
}

const dataSourceConfig: Record<DataSource, { icon: typeof Database; label: string; color: string }> = {
  api: { icon: Cloud, label: 'Dr Green API', color: 'bg-sky-500/20 text-sky-300 border-sky-400/30' },
  none: { icon: AlertCircle, label: 'No Data', color: 'bg-amber-500/20 text-amber-300 border-amber-400/30' },
};

export function ProductCard({ product, onViewDetails, showDataSource = false }: ProductCardProps) {
  const { addToCart, isEligible, drGreenClient, countryCode, convertFromEUR } = useShop();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation('shop');
  const isMobile = useIsMobile();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addedSuccess, setAddedSuccess] = useState(false);

  const hasVideo = !!product.videoUrl;

  const [quantity, setQuantity] = useState(1);

  const handleAddToCart = async () => {
    if (!drGreenClient) {
      toast({ title: t('eligibility.required'), description: t('eligibility.requiredDescription'), variant: "destructive" });
      navigate('/shop/register');
      return;
    }
    if (!isEligible) {
      toast({ title: t('eligibility.pending'), description: t('eligibility.kycPending'), variant: "destructive" });
      return;
    }

    setIsAdding(true);
    try {
      await addToCart({ strain_id: product.id, strain_name: product.name, quantity, unit_price: product.retailPrice });
      setAddedSuccess(true);
      toast({ title: "Added to cart", description: `${quantity}g of ${product.name} added to your cart.` });
      setQuantity(1);
      // Reset success state after 2s
      setTimeout(() => setAddedSuccess(false), 2000);
    } finally {
      setIsAdding(false);
    }
  };

  const incrementQty = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setQuantity(q => Math.min(product.stock, q + 1));
  }, [product.stock]);

  const decrementQty = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setQuantity(q => Math.max(1, q - 1));
  }, []);

  const handleMouseEnter = () => {
    setIsHovered(true);
    if (hasVideo && videoRef.current && !isMobile) { videoRef.current.play().catch(() => {}); }
  };
  const handleMouseLeave = () => {
    setIsHovered(false);
    if (hasVideo && videoRef.current && !isMobile) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
  };

  const getCategoryStyles = (category: string) => {
    switch (category.toLowerCase()) {
      case 'sativa': return { badge: 'bg-amber-500/25 text-amber-700 dark:text-amber-300 border-amber-400/40 backdrop-blur-sm', glow: 'hover:shadow-amber-500/20' };
      case 'indica': return { badge: 'bg-violet-500/25 text-violet-700 dark:text-violet-300 border-violet-400/40 backdrop-blur-sm', glow: 'hover:shadow-violet-500/20' };
      case 'hybrid': return { badge: 'bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 border-emerald-400/40 backdrop-blur-sm', glow: 'hover:shadow-emerald-500/20' };
      case 'cbd': return { badge: 'bg-cyan-500/25 text-cyan-700 dark:text-cyan-300 border-cyan-400/40 backdrop-blur-sm', glow: 'hover:shadow-cyan-500/20' };
      default: return { badge: 'bg-slate-500/25 text-slate-700 dark:text-slate-300 border-slate-400/40', glow: '' };
    }
  };

  const categoryStyles = getCategoryStyles(product.category);
  const sourceConfig = dataSourceConfig[product.dataSource || 'api'];
  const SourceIcon = sourceConfig.icon;

  const getButtonContent = () => {
    if (!product.availability) return (<><ShoppingCart className="mr-2 h-4 w-4" />{t('outOfStock')}</>);
    if (!drGreenClient) return (<><Lock className="mr-2 h-4 w-4" />Register to Buy</>);
    if (!isEligible) return (<><Lock className="mr-2 h-4 w-4" />Verification Required</>);
    if (isAdding) return (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Adding...</>);
    if (addedSuccess) return (<><Check className="mr-2 h-4 w-4" />Added!</>);
    return (<><ShoppingCart className="mr-2 h-4 w-4" />{t('addToCart')}</>);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -6, scale: 1.01 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="h-full cursor-pointer"
      onClick={() => navigate(`/shop/strain/${product.id}`)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={`group relative h-full overflow-hidden rounded-2xl bg-gradient-to-b from-card to-card/80 dark:from-card/90 dark:to-card/60 backdrop-blur-xl border border-border/50 dark:border-white/10 shadow-xl shadow-black/10 dark:shadow-black/20 hover:shadow-2xl hover:shadow-primary/20 transition-all duration-500 ${categoryStyles.glow}`}>
        <div className="absolute inset-0 bg-gradient-to-br from-white/5 via-transparent to-black/20 pointer-events-none" />

        {/* Image / Video */}
        <div className="relative aspect-square overflow-hidden bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900/40 dark:to-slate-900/60">
          {hasVideo ? (
            <video ref={videoRef} src={product.videoUrl} muted loop playsInline autoPlay={isMobile} poster={product.imageUrl} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
          ) : (
            <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" loading="lazy" />
          )}

          {/* Quick view */}
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            whileHover={{ scale: 1.1 }}
            className="absolute top-4 right-4 p-2.5 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white opacity-0 group-hover:opacity-100 transition-all duration-300 hover:bg-white/20"
            onClick={(e) => { e.stopPropagation(); onViewDetails(product); }}
          >
            <Eye className="h-4 w-4" />
          </motion.button>

          {/* Data source debug badge */}
          {showDataSource && (
            <div className={`absolute top-4 right-16 flex items-center gap-1.5 px-2 py-1 rounded-full border text-[10px] font-medium ${sourceConfig.color}`}>
              <SourceIcon className="h-3 w-3" />
              <span>{sourceConfig.label}</span>
            </div>
          )}

          {/* Out of stock */}
          {!product.availability && (
            <div className="absolute bottom-0 left-0 right-0 bg-sky-600/90 backdrop-blur-sm py-2 px-4 flex items-center justify-center">
              <span className="text-sm font-semibold text-white uppercase tracking-wide">{t('outOfStock')}</span>
            </div>
          )}
        </div>

        {/* Content — Effect-First Hierarchy */}
        <div className="relative p-5 space-y-3">
          {/* 1. Name + Price */}
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-bold text-lg text-foreground leading-tight line-clamp-1 group-hover:text-primary transition-colors">
              {product.name}
            </h3>
            <div className="flex flex-col items-end shrink-0">
              <PriceBreakdownTooltip>
                <span className="text-xl font-bold text-primary">
                  {formatPrice(convertFromEUR(product.retailPrice), countryCode)}
                </span>
              </PriceBreakdownTooltip>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">per gram</span>
            </div>
          </div>

          {/* 2. Effect tags — prominent, high-contrast with mood icons */}
          {product.effects.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {product.effects.slice(0, 3).map((effect) => {
                const Icon = getEffectIcon(effect);
                return (
                  <span
                    key={effect}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full bg-primary/10 dark:bg-primary/20 border border-primary/25 text-primary"
                  >
                    <Icon className="h-3 w-3" />
                    {effect}
                  </span>
                );
              })}
              {product.effects.length > 3 && (
                <span className="px-2.5 py-1 text-xs font-medium rounded-full bg-muted/60 dark:bg-white/10 border border-border/50 text-muted-foreground">
                  +{product.effects.length - 3}
                </span>
              )}
            </div>
          )}

          {/* 3. Terpene / Flavour tags — secondary row */}
          {product.terpenes.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Flavour</span>
              {product.terpenes.slice(0, 3).map((terpene) => (
                <span
                  key={terpene}
                  className="px-2 py-0.5 text-[11px] font-medium rounded-full bg-muted/50 dark:bg-white/5 border border-border/40 dark:border-white/10 text-muted-foreground"
                >
                  {terpene}
                </span>
              ))}
              {product.terpenes.length > 3 && (
                <span className="text-[11px] text-muted-foreground/60">+{product.terpenes.length - 3}</span>
              )}
            </div>
          )}

          {/* 4. THC / CBD — compact inline, informational */}
          <div className="flex items-center gap-2.5 pt-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Leaf className="h-3 w-3 text-emerald-600/70 dark:text-emerald-400/70" />
              <span className="font-semibold text-foreground/80">{product.thcContent.toFixed(1)}%</span>
              <span className="text-[10px] uppercase">THC</span>
            </div>
            <div className="w-px h-3 bg-border" />
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Droplets className="h-3 w-3 text-cyan-600/70 dark:text-cyan-400/70" />
              <span className="font-semibold text-foreground/80">{product.cbdContent.toFixed(1)}%</span>
              <span className="text-[10px] uppercase">CBD</span>
            </div>
          </div>

          {/* 5. Quantity + CTA */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 rounded-lg"
                onClick={decrementQty}
                disabled={quantity <= 1}
              >
                <Minus className="h-3 w-3" />
              </Button>
              <span className="w-8 text-center text-sm font-bold">{quantity}g</span>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 rounded-lg"
                onClick={incrementQty}
                disabled={quantity >= product.stock}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
            <Button
              className="flex-1 h-10 rounded-xl font-semibold transition-all duration-300 shadow-lg hover:shadow-xl text-sm"
              disabled={!product.availability || isAdding}
              variant={addedSuccess ? "default" : (!drGreenClient || !isEligible ? "secondary" : "default")}
              onClick={(e) => { e.stopPropagation(); handleAddToCart(); }}
            >
              {getButtonContent()}
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
